/**
 * A running pi keeps its own install out of the Nix store's collection.
 *
 * A switch moves pi's install links to a new store path and collects the
 * old one. The garbage collector spares only what a root names or a
 * process holds open, and a running pi holds open little of its install:
 * at 12:02 on 17 November a switch collected the store path every
 * session started before it ran from, and each of them then failed to
 * start a subagent or a council ("Pi runtime stale") until restarted.
 *
 * So each pi, a host included, roots the store paths it runs from (its
 * node, its entry script and its assets) with an indirect root, a link
 * in a folder of its own named for the process and when it started. A
 * root outlives a pi that is killed, so each start also removes the
 * roots of processes that are gone; nothing waits on an exit hook, which
 * a host's conversations may not add.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getParentPiInstall } from "../../subagent/install.ts";
import { processGlobal } from "../process/process-global.ts";

/** A store path's own folder: `/nix/store/<hash>-<name>`. */
const STORE_PATH = /^\/nix\/store\/[0-9a-z]{32}-[^/]+/;

/** How long `nix-store` may take to add one root. */
const ADD_ROOT_MS = 10_000;

/**
 * The store paths `paths` lie in, each once, in order; a path outside
 * the store names none.
 */
export function storePathsOf(paths: readonly string[]): string[] {
	const found = paths.flatMap((path) => STORE_PATH.exec(path)?.[0] ?? []);
	return [...new Set(found)];
}

/** A process as its roots are named: its id and when it started. */
export interface HeldProcess {
	readonly pid: number;
	readonly started: string;
}

/**
 * When process `pid` started, as the kernel counts it, or undefined
 * when there is no such process. Where there is no /proc, as on a Mac,
 * it is "0" for any process that answers a signal, so a reused id is
 * read as the same process: its root then lingers until that one ends.
 */
export function startOf(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command's name, in parentheses, may hold spaces: the fields
		// counted after its closing one are fixed.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[19];
	} catch {
		// No /proc entry: on Linux the process is gone; elsewhere, ask it.
	}
	if (process.platform === "linux") return undefined;
	try {
		process.kill(pid, 0);
		return "0";
	} catch (error) {
		// EPERM is a process of someone else's, which still runs.
		return error instanceof Error && "code" in error && error.code === "EPERM"
			? "0"
			: undefined;
	}
}

/** A root's link name: the process, when it started, and which path. */
function rootName(owner: HeldProcess, index: number): string {
	return `${owner.pid}-${owner.started}-${index}`;
}

/**
 * Remove the roots in `folder` whose process is gone or is another
 * started since, by `startOf`. Returns the names removed.
 */
export function sweepHeld(
	folder: string,
	start: (pid: number) => string | undefined = startOf,
): string[] {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// No folder yet: no pi has held anything here.
		return [];
	}
	return names.filter((name) => {
		const [pid, started] = name.split("-");
		const live = start(Number(pid));
		if (live !== undefined && live === started) return false;
		rmSync(join(folder, name), { force: true });
		return true;
	});
}

/** Adds one indirect root at `link` naming `storePath`. */
export type AddRoot = (link: string, storePath: string) => Promise<void>;

/** `nix-store` adding an indirect root, refused after ten seconds. */
export const addRootWithNixStore: AddRoot = (link, storePath) =>
	new Promise((resolve, reject) => {
		execFile(
			"nix-store",
			["--add-root", link, "--realise", storePath],
			{ timeout: ADD_ROOT_MS },
			(error, _stdout, stderr) =>
				error ? reject(new Error(stderr.trim() || error.message)) : resolve(),
		);
	});

/**
 * Root each store path among `paths` in `folder` for `owner`, after
 * sweeping the roots of processes that are gone. Resolves to the links
 * made; a path whose root can't be added rejects, naming it.
 */
export async function holdInstall(
	paths: readonly string[],
	folder: string,
	owner: HeldProcess,
	add: AddRoot = addRootWithNixStore,
	start: (pid: number) => string | undefined = startOf,
): Promise<string[]> {
	const storePaths = storePathsOf(paths);
	if (storePaths.length === 0) return [];
	sweepHeld(folder, start);
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	const links: string[] = [];
	for (const [index, storePath] of storePaths.entries()) {
		const link = join(folder, rootName(owner, index));
		try {
			await add(link, storePath);
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			throw new Error(`${storePath} can't be kept from collection: ${why}`);
		}
		links.push(link);
	}
	return links;
}

/**
 * Hold this process's pi install in `folder`, once however many
 * extension instances or reloads ask: the install taken at start (a
 * host's own, pinned before its conversations load), rooted for this
 * process. A root that can't be added is said through `say`, once.
 */
export function holdRunningInstall(
	folder: string,
	say: (why: string) => void,
): Promise<string[]> {
	return processGlobal("pi.install.held", () => {
		const started = startOf(process.pid) ?? "0";
		let paths: string[];
		try {
			const install = getParentPiInstall();
			paths = [install.node, install.entry, install.packageDir ?? ""];
		} catch (error) {
			// A process with no install of pi's to read runs nothing of it
			// from the store to hold.
			say(
				`pi's install can't be read, so nothing keeps it from collection: ${String(error)}`,
			);
			return Promise.resolve([]);
		}
		return holdInstall(paths, folder, { pid: process.pid, started }).catch(
			(error: unknown) => {
				say(
					`A switch may collect the pi this session runs: ${error instanceof Error ? error.message : String(error)}`,
				);
				return [];
			},
		);
	});
}
