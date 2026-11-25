/**
 * Handing a pi's window to what its holder starts next: the host's join
 * for a move (mesh-workflow's in-place.ts), or the host's view for a
 * conversation a host already holds (one-writer-workflow). Both ask the
 * same of a pi before it may, tell its holder the same way, and end the
 * same way, so the window keeps pi's last frame until the next program
 * draws over it.
 */

import { rmSync, writeFileSync } from "node:fs";
import {
	flagsLost,
	type HolderFiles,
	holderFiles,
	PARKED_EXIT,
	sayParkedIn,
} from "./park.ts";

/** What a pi needs before it may hand its window over. */
export interface HandingFacts {
	/** The variables it runs with. */
	readonly env: NodeJS.ProcessEnv;
	/** Its own process. */
	readonly pid: number;
	/** The arguments pi was started with. */
	readonly args: readonly string[];
	/** The session's log, which plain pi opens should what's next fall back. */
	readonly sessionFile: string | undefined;
}

/** Where a pi that may hand its window over tells its holder, with its log. */
export interface Handing {
	readonly files: HolderFiles;
	readonly sessionFile: string;
}

/**
 * Where this pi would tell its holder what starts next, or nothing when
 * it may not hand its window over: no holder runs it itself, its holder
 * takes no next command, it has no log yet, or it carries flags plain pi
 * would drop should what starts next fall back to it.
 */
export function handingOf(facts: HandingFacts): Handing | undefined {
	const files = holderFiles(facts.env, facts.pid);
	if (files === undefined || facts.sessionFile === undefined) return undefined;
	if (flagsLost(facts.args).length > 0) return undefined;
	return { files, sessionFile: facts.sessionFile };
}

/**
 * Whether a holder was told what starts next, and, when it wasn't, why:
 * the error writing its file gave, which names the file and the cause,
 * as a full disk or a folder where the file should be. See
 * {@link whyWriting}.
 */
export type Told =
	| { readonly told: true }
	| { readonly told: false; readonly why: string };

/**
 * Tells the holder to start `command` next, woken at once with `wake`'s
 * words. Untold when either file can't be written, with both taken away,
 * even one cut short as it was written, so the holder starts nothing
 * half told. Told, it also says the run parked where the holder names
 * a file for it, since the run ends with {@link PARKED_EXIT}.
 */
export function tellHolder(
	files: HolderFiles,
	command: readonly string[],
	wake: Readonly<Record<string, unknown>>,
): Told {
	let writing = files.again;
	try {
		writeFileSync(files.again, JSON.stringify(command));
		writing = files.wake;
		writeFileSync(files.wake, JSON.stringify(wake));
		if (files.parked !== undefined) sayParkedIn(files.parked);
		return { told: true };
	} catch (error) {
		untellHolder(files);
		return { told: false, why: whyWriting(writing, error) };
	}
}

/**
 * Names the command a holder starts a pi that quit unasked again with,
 * as its session's own, so it comes back to the same conversation
 * rather than a new one. Only the command is written: the holder
 * restarts on the exit code, so no wake is needed, and parking after
 * quick quits is the holder's to say, so no park is. Untold, the file
 * is taken away, even one cut short, so the holder reads no half.
 */
export function nameRestart(
	files: HolderFiles,
	command: readonly string[],
): Told {
	try {
		writeFileSync(files.again, JSON.stringify(command));
		return { told: true };
	} catch (error) {
		forget(files.again);
		return { told: false, why: whyWriting(files.again, error) };
	}
}

/**
 * Why writing `path` failed, naming the file: an error from opening it
 * names it already, but one from the write itself, as a full disk's
 * ENOSPC, names only the call. It never ends in a full stop, so a
 * caller ends its own sentence after it: a message said as a sentence,
 * as writeWhole's refusal of a staging folder that is a link, loses its
 * full stop, whether the file is named after it or not.
 */
export function whyWriting(path: string, error: unknown): string {
	const message = (
		error instanceof Error ? error.message : String(error)
	).replace(/\.$/, "");
	return message.includes(path) ? message : `${message}, to ${path}`;
}

/**
 * Takes back what {@link tellHolder} told, so the holder starts nothing
 * next: for a hand-over called off after its holder was told.
 */
export function untellHolder(files: HolderFiles): void {
	forget(files.again);
	forget(files.wake);
	// Still running, it hasn't parked: a quit whose exit hangs later
	// must not count as one.
	if (files.parked !== undefined) forget(files.parked);
}

/**
 * From here on this process reads no keys, leaves the terminal as it is
 * and writes nothing to it, and ends with PARKED_EXIT whatever pi ends
 * with, so its holder starts what it named at once, over pi's last
 * frame: no restored screen, resume hint or notice flashes first.
 */
export function goQuiet(): void {
	// Paused outright, so even pi's drain at exit reads none of the keys.
	process.stdin.pause();
	// Left raw: cooked, the terminal would echo what Joel types over the
	// frame until what starts next takes it raw again.
	if (process.stdin.isTTY) process.stdin.setRawMode = () => process.stdin;
	process.stdout.write = nothingWritten;
	process.stderr.write = nothingWritten;
	// pi ends a quit with process.exit(0); an exit listener's code wins.
	process.once("exit", () => {
		process.exitCode = PARKED_EXIT;
	});
}

/**
 * Writes nothing, so pi's last frame stays on the terminal, yet answers
 * as a write that was flushed: a callback given is called, so a shutdown
 * step that waits for its write to land still ends.
 */
function nothingWritten(...args: unknown[]): boolean {
	const done = args.find((arg) => typeof arg === "function");
	if (typeof done === "function") process.nextTick(() => done());
	return true;
}

/** Removes `path` if it can be. */
function forget(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// Left as it is: nothing more can be undone here, and the caller
		// still says why it can't hand over.
	}
}
