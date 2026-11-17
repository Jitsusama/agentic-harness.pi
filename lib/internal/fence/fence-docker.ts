/**
 * Whether Docker's settings hold a credential, which the fence then
 * empties: `~/.docker/config.json` keeps registries' logins in `auths`
 * (a base64 name and password, or an identity token), and `credsStore`
 * names the helper that answers every registry's from the person's
 * keychain (ISXEG8, 16 November). Settings naming only per-registry
 * helpers (`credHelpers`) stay, since a fenced command reaches no
 * keychain through them, and a fenced docker pulls what is public.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../record.ts";
import type { Disk } from "./fence-disk.ts";

/** Docker's settings, as a path from the home folder. */
export const DOCKER_CONFIG = ".docker/config.json";

/** What a login in `auths` carries when it carries one. */
const LOGIN_FIELDS = ["auth", "identitytoken", "password", "registrytoken"];

/** A file's text, or nothing where it isn't there or can't be read. */
function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		// Not there or not readable: no settings, so nothing to hide.
		return undefined;
	}
}

/** bubblewrap's arguments emptying Docker's settings, a link's target if one. */
export function dockerArgs(home: string, disk: Disk): string[] {
	const path = join(home, DOCKER_CONFIG);
	const over = disk.kind(path) === "link" ? disk.real?.(path) : path;
	if (over === undefined || disk.kind(over) !== "file") return [];
	return ["--ro-bind", "/dev/null", over];
}

/**
 * Whether Docker's settings under `home` hold a login or name a
 * keychain helper. Settings that don't parse are held to, since what
 * they hold can't be told.
 */
export function dockerHoldsCredentials(
	home: string,
	read: (path: string) => string | undefined = readText,
): boolean {
	const text = read(join(home, DOCKER_CONFIG));
	if (text === undefined) return false;
	let said: unknown;
	try {
		said = JSON.parse(text);
	} catch {
		// Unreadable settings may hold anything, so they are hidden.
		return true;
	}
	if (!isRecord(said)) return true;
	const store = field(said, "credsStore");
	if (typeof store === "string" && store !== "") return true;
	// Headers sent to every registry can carry a login of their own.
	const headers = field(said, "HttpHeaders");
	if (isRecord(headers) && Object.keys(headers).length > 0) return true;
	// A proxy's address can carry a name and password of its own.
	const proxies = field(said, "proxies");
	if (proxies !== undefined && /:\/\/[^/@\s]+@/.test(JSON.stringify(proxies)))
		return true;
	const auths = field(said, "auths");
	return Object.values(isRecord(auths) ? auths : {}).some(
		(login) =>
			isRecord(login) &&
			LOGIN_FIELDS.some((name) => {
				const value = field(login, name);
				return typeof value === "string" && value !== "";
			}),
	);
}

/** A setting by name in any case, as Docker's own reader matches it. */
function field(settings: Record<string, unknown>, name: string): unknown {
	const wanted = name.toLowerCase();
	return Object.entries(settings).find(
		([key]) => key.toLowerCase() === wanted,
	)?.[1];
}
