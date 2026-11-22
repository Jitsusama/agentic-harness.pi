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
import { systemFolders, systemProgram } from "../sandbox/system-program.ts";

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

/** A root's name as `rootName` writes it, and nothing else. */
const ROOT_NAME = /^(\d+)-(\d+)-\d+$/;

/**
 * Remove the roots in `folder` whose process is gone or is another
 * started since, by `startOf`. Only names this module writes are read,
 * so a link nix-store is still making is left alone, and a root that
 * can't be removed is left for a later sweep. Returns the names removed.
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
		const parts = ROOT_NAME.exec(name);
		if (!parts) return false;
		const live = start(Number(parts[1]));
		if (live !== undefined && live === parts[2]) return false;
		try {
			rmSync(join(folder, name), { force: true });
			return true;
		} catch {
			// Left for the next start's sweep: it only keeps an old install.
			return false;
		}
	});
}

/** Adds one indirect root at `link` naming `storePath`. */
export type AddRoot = (link: string, storePath: string) => Promise<void>;

/**
 * The system's own `nix-store`, never one found on PATH, which a fenced
 * command could plant (system-program.ts): from the system's profiles,
 * or the Nix installer's default profile on a Mac.
 */
function nixStore(): string | undefined {
	const folders = [...systemFolders(), "/nix/var/nix/profiles/default/bin"];
	// Run by the link it was found at, not the program it resolves to:
	// nix-store is the one `nix` program, which reads what it is from the
	// name it was run by.
	const folder = folders.find(
		(one) => systemProgram("nix-store", [one]) !== undefined,
	);
	return folder === undefined ? undefined : join(folder, "nix-store");
}

/** `nix-store` adding an indirect root, refused after ten seconds. */
export const addRootWithNixStore: AddRoot = (link, storePath) =>
	new Promise((resolve, reject) => {
		const program = nixStore();
		if (program === undefined) {
			reject(new Error("the system has no nix-store of its own"));
			return;
		}
		execFile(
			program,
			["--add-root", link, "--realise", storePath],
			{ timeout: ADD_ROOT_MS },
			(error, _stdout, stderr) =>
				error ? reject(new Error(stderr.trim() || error.message)) : resolve(),
		);
	});

/** What a hold rooted, and why each path it couldn't root wasn't. */
export interface Held {
	readonly links: readonly string[];
	readonly missed: readonly string[];
}

/**
 * Root each store path among `paths` in `folder` for `owner`, after
 * sweeping the roots of processes that are gone. Each path is tried on
 * its own, so one refused still leaves the others rooted.
 */
export async function holdInstall(
	paths: readonly string[],
	folder: string,
	owner: HeldProcess,
	add: AddRoot = addRootWithNixStore,
	start: (pid: number) => string | undefined = startOf,
): Promise<Held> {
	const storePaths = storePathsOf(paths);
	if (storePaths.length === 0) return { links: [], missed: [] };
	sweepHeld(folder, start);
	try {
		mkdirSync(folder, { recursive: true, mode: 0o700 });
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		return { links: [], missed: storePaths.map((path) => `${path}: ${why}`) };
	}
	const links: string[] = [];
	const missed: string[] = [];
	for (const [index, storePath] of storePaths.entries()) {
		const link = join(folder, rootName(owner, index));
		try {
			await add(link, storePath);
			links.push(link);
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			missed.push(`${storePath}: ${why}`);
		}
	}
	return { links, missed };
}

/** What to tell the person of a hold that missed, or nothing. */
export function heldNote(held: Held): string | undefined {
	if (held.missed.length === 0) return undefined;
	return `A system switch may collect the pi this session runs, so its subagents and councils would fail until it restarts: ${held.missed.join("; ")}`;
}

/** Where a session shows the person a note: pi's context, as far as a note needs it. */
export interface NoteScreen {
	readonly hasUI: boolean;
	readonly ui: {
		notify(message: string, level: "warning"): void;
	};
}

/** Whether this process has said its hold's note yet. */
export interface SaidOnce {
	said: boolean;
}

/**
 * Say once in this process, where the person sees it, what the hold
 * missed. The hold resolves after the session that asked may have been
 * replaced, and a replaced session's context throws on every read, its
 * `hasUI` included; such a session says nothing, and the next one
 * says the note instead, so a replacement never fails the call.
 */
export async function sayHeldOnce(
	held: Promise<Held>,
	screen: NoteScreen,
	once: SaidOnce = processGlobal("pi.install.held.said", () => ({
		said: false,
	})),
): Promise<void> {
	const note = heldNote(await held);
	if (note === undefined || once.said) return;
	try {
		if (!screen.hasUI) return;
		once.said = true;
		screen.ui.notify(note, "warning");
	} catch {
		// The session was replaced while the hold ran: the next one says it.
		once.said = false;
	}
}

/**
 * Hold this process's pi install in `folder`, once however many
 * extension instances or reloads ask: the install taken at start (a
 * host's own, pinned before its conversations load), rooted for this
 * process. Every caller gets the one hold, to say what it missed.
 */
export function holdRunningInstall(folder: string): Promise<Held> {
	return processGlobal("pi.install.held", () => {
		const started = startOf(process.pid) ?? "0";
		let paths: string[];
		try {
			const install = getParentPiInstall();
			paths = [install.node, install.entry, install.packageDir ?? ""];
		} catch (error) {
			return Promise.resolve({
				links: [],
				missed: [`pi's install can't be read: ${String(error)}`],
			});
		}
		return holdInstall(paths, folder, { pid: process.pid, started });
	});
}
