/**
 * What a host would run if it started now, beside what it runs: the
 * harness code its own process loads, and the unit systemd starts it by.
 *
 * A running host keeps both for its life. Its conversations follow the
 * install between their runs (reload-workflow's follower), but the host
 * program, and the code under host/ it loads once, move only when the
 * process does; the unit is `X-SwitchMethod=keep-old`, so a switch that
 * gives it a new pi leaves the old one running too (OSPHT4's found loss,
 * 10 November). Each is read as one fingerprint, so a host compares two
 * strings: a version whose host code is byte for byte the same as its
 * own, or a unit file no switch rewrote, asks for nothing.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

/** The host program, from a version's root. */
export const HOST_ENTRY = "scripts/pi-host.ts";

/**
 * What a host loads beside its own modules: the third-party packages it
 * imports, which these two decide.
 */
const DEPENDENCY_FILES = ["package.json", "pnpm-lock.yaml"] as const;

/** How long one systemctl call may take before the unit counts as unread. */
const SYSTEMCTL_TIMEOUT_MS = 5_000;

/**
 * A module's relative imports, each a static import or re-export that
 * isn't type-only, a side-effect import, or a dynamic import of a
 * literal. Type-only imports vanish as node strips types, so a change to
 * a module only they reach changes nothing the host runs.
 */
const IMPORTS = [
	/(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?[^;'"]*?\sfrom\s*["'](\.{1,2}\/[^"']+)["']/g,
	/(?:^|[\n;])\s*import\s*()["'](\.{1,2}\/[^"']+)["']/g,
	/\bimport\(\s*()["'](\.{1,2}\/[^"']+)["']\s*\)/g,
] as const;

/**
 * The fingerprint of the harness code a host started from `root` loads
 * itself: every module its program reaches through relative imports,
 * by path and content, and the files that decide its packages. A module
 * that can't be read is fingerprinted as missing, so a version that lost
 * one differs from one that has it.
 */
export async function hostCodeOf(root: string): Promise<string> {
	const hash = createHash("sha256");
	for (const file of await hostModules(root)) {
		hash.update(`${relative(root, file)}\0`);
		hash.update(await contentOf(file));
		hash.update("\0");
	}
	for (const name of DEPENDENCY_FILES) {
		hash.update(`${name}\0`);
		hash.update(await contentOf(join(root, name)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** Every module the host program under `root` reaches, in a stable order. */
export async function hostModules(root: string): Promise<string[]> {
	const seen = new Set<string>();
	const waiting = [resolve(root, HOST_ENTRY)];
	for (let file = waiting.pop(); file !== undefined; file = waiting.pop()) {
		if (seen.has(file)) continue;
		seen.add(file);
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch {
			// A module the program names but the version lacks: kept in the
			// list, so its absence is part of the fingerprint.
			continue;
		}
		for (const specifier of relativeImports(text))
			waiting.push(resolve(dirname(file), specifier));
	}
	return [...seen].sort();
}

/** The relative specifiers a module imports at runtime. */
export function relativeImports(text: string): string[] {
	const found: string[] = [];
	for (const pattern of IMPORTS)
		for (const match of text.matchAll(pattern)) {
			const [, typeOnly, specifier] = match;
			if (!typeOnly && specifier) found.push(specifier);
		}
	return found;
}

async function contentOf(file: string): Promise<Buffer | string> {
	try {
		return await readFile(file);
	} catch {
		// Missing reads as a marker no file's bytes can be, as a whole.
		return "\u0000missing";
	}
}

/**
 * The systemd unit this process runs in, from its cgroup, or nothing
 * outside one: a host run by hand, or by a test.
 */
export async function ownUnit(
	cgroupFile = "/proc/self/cgroup",
): Promise<string | undefined> {
	let text: string;
	try {
		text = await readFile(cgroupFile, "utf8");
	} catch {
		// No cgroup file: not Linux, or no /proc, so no unit to speak of.
		return undefined;
	}
	const unified = text.split("\n").find((line) => line.startsWith("0::"));
	const unit = unified?.split("/").pop();
	return unit?.endsWith(".service") ? unit : undefined;
}

/** Runs `systemctl --user` with these arguments, answering what it printed. */
export type Systemctl = (args: readonly string[]) => Promise<string>;

/** The machine's systemctl, for the login's own manager. */
export const userSystemctl: Systemctl = (args) =>
	new Promise((done, fail) => {
		execFile(
			"systemctl",
			["--user", ...args],
			{ timeout: SYSTEMCTL_TIMEOUT_MS },
			(error, stdout) => (error ? fail(error) : done(stdout)),
		);
	});

/**
 * Whether `pid` is the main process of `unit`, so a restart of the unit
 * restarts it: a host a test starts inside some other unit's cgroup, such
 * as a hosted conversation running the host tests, is never it.
 */
export async function isUnitMain(
	unit: string,
	pid: number,
	systemctl: Systemctl = userSystemctl,
): Promise<boolean> {
	try {
		const said = await systemctl(["show", unit, "--property=MainPID"]);
		return said.trim() === `MainPID=${pid}`;
	} catch {
		// systemd didn't answer: nothing shows this process is the unit's.
		return false;
	}
}

/**
 * The fingerprint of the unit as systemd would start it now: where its
 * file and drop-ins resolve, which a switch moves to new store paths as it
 * rewrites them. Nothing while systemd hasn't read a changed file yet,
 * since a restart then would start the old unit again; nor when systemd
 * can't be asked.
 */
export async function unitDefinition(
	unit: string,
	systemctl: Systemctl = userSystemctl,
): Promise<string | undefined> {
	let said: string;
	try {
		said = await systemctl([
			"show",
			unit,
			"--property=NeedDaemonReload,FragmentPath,DropInPaths",
		]);
	} catch {
		// systemd didn't answer: nothing is known to have changed.
		return undefined;
	}
	const properties = new Map<string, string>();
	for (const line of said.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) properties.set(line.slice(0, at), line.slice(at + 1));
	}
	if (properties.get("NeedDaemonReload") !== "no") return undefined;
	const fragment = properties.get("FragmentPath") ?? "";
	if (fragment === "") return undefined;
	const files = [fragment, ...(properties.get("DropInPaths") ?? "").split(" ")];
	const resolved = await Promise.all(
		files
			.filter((file) => file !== "")
			.map((file) => realpath(file).catch(() => file)),
	);
	return resolved.join("\n");
}
