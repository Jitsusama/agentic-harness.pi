/**
 * The person's npm settings as a fenced command reads them: every line
 * but those holding a registry's token. `dev up` writes `~/.npmrc` with
 * the registries Shopify's packages come from, a helper that signs
 * package-proxy's requests, and a Cloudsmith token, so a fenced pnpm
 * needs the file but no fenced command should read the token (IDEGAT,
 * 13 November). A copy without the token's lines, made outside, is bound
 * over the file inside; pi's own file tools are refused the file itself
 * (`fenceRefusesRead`).
 *
 * A fenced install of a private package straight from Cloudsmith then
 * fails with a 401, as one in a sandbox with no token does; Tectonix
 * fetches those through the Nix daemon, which needs none.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fenceCopy } from "./fence-copy.ts";
import { FENCE_HIDDEN } from "./fence-hidden.ts";

/** The person's npm settings, as a path from the home folder. */
export const NPMRC = FENCE_HIDDEN.npmrc;

/**
 * A setting that is a credential: `_authToken`, `_auth` or `_password`,
 * bare or for one registry (`//host/path/:_authToken`). A helper's path
 * (`tokenHelper`) and a certificate's (`certfile`, `keyfile`) name a file
 * and stay.
 */
const CREDENTIAL = /^\s*((?:[^=;#\s]*:)?_(?:authToken|auth|password))\s*=/;

/**
 * A setting whose value is an address carrying a name and password
 * (`registry=https://name:password@host/`), which npm sends as the
 * registry's credential.
 */
const USERINFO = /^\s*([^=;#\s]+)\s*=.*:\/\/[^/@\s]+@/;

/** The setting a line gives a credential, or nothing when it gives none. */
function credentialIn(line: string): string | undefined {
	return CREDENTIAL.exec(line)?.[1] ?? USERINFO.exec(line)?.[1];
}

/**
 * `text` with each credential's line replaced by a comment naming its
 * setting, never its value; or nothing when it holds none and needs no
 * copy.
 */
export function withoutNpmTokens(text: string): string | undefined {
	const lines = text.split("\n");
	if (!lines.some((line) => credentialIn(line) !== undefined)) return undefined;
	return lines
		.map((line) => {
			const setting = credentialIn(line);
			return setting === undefined
				? line
				: `; ${setting} is held back by the agent fence`;
		})
		.join("\n");
}

/** A file's text, or nothing where it isn't there or can't be read. */
function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		// Not there or not readable: no settings, so nothing to copy.
		return undefined;
	}
}

/** What stands in for a file holding tokens when no copy can be made. */
const EMPTY = "/dev/null";

/**
 * The copy of `~/.npmrc` the fence binds over it, in pi's folder in the
 * runtime folder, written when it changes; nothing when the file holds
 * no token and needs no copy; or `/dev/null` when it does and none can
 * be written, so the token is never left readable for want of a copy.
 */
export function fenceNpmrc(
	home: string,
	runtimeDir: string | undefined,
	read: (path: string) => string | undefined = readText,
): string | undefined {
	const settings = read(join(home, NPMRC));
	const copy = settings === undefined ? undefined : withoutNpmTokens(settings);
	if (copy === undefined) return undefined;
	return fenceCopy(runtimeDir, "npmrc", copy, read) ?? EMPTY;
}
