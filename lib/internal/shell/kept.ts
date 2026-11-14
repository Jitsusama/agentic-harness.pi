/**
 * What a bash call keeps of itself on disk, so another process can say
 * how it ended: its output, its exit status and its shell's pid.
 *
 * pi reads a command's output and status only through the pipes it
 * holds, and both die with it. So a session that moved to a host while
 * a command ran could never be told how it ended, and a move waited out
 * every command instead: on 12 November a wave moved none of seven
 * sessions, since each always had one running. shell-workflow's stub
 * (command-line.ts) copies the output into `<path>.out` through
 * `tee -p`, which writes on to the file once pi has gone, and writes the
 * status to `<path>.end` and the shell's pid to `<path>.pid`.
 *
 * Output on disk is output anyone could read, so the files are made
 * 0600 in a folder of 0700 under the state directory, never a shared
 * temp folder. `.out` is kept to its last `KEPT_BYTES`: past that its
 * tail moves to `.old` and `.out` starts again, so at most twice that is
 * on disk. Bytes written in the instant of that move can be lost. The
 * files go when the call ends in its pi, or once a carried call's end is
 * said; any left a week are swept.
 *
 * A call handed to another process is marked `<path>.carried` until its
 * end is said, so a host that reaps what its conversations started
 * (host/engine/tool-children.ts) spares it: its shell still carries the
 * marks of the host that started it, which no longer answers for it.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { stateDir } from "../paths.ts";

/** The most of a command's output kept in `.out` before its tail moves to `.old`. */
export const KEPT_BYTES = 1024 * 1024;

/** How long kept files may sit before a sweep takes them as nobody's. */
export const KEPT_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** Only the owner reads or writes them. */
const FILE_MODE = 0o600;
const FOLDER_MODE = 0o700;

/** The files a kept call writes, by the suffix each adds to its path. */
const SUFFIXES = [".out", ".old", ".end", ".pid", ".carried"] as const;

/** The suffix marking a call handed to another process. */
const CARRIED = ".carried";

/** Where kept calls go: shell-workflow's state, under XDG_STATE_HOME. */
export function keptFolder(): string {
	return join(stateDir("shell-workflow"), "kept");
}

/**
 * A new call's path in `folder`, with its `.out`, `.end` and `.pid` made
 * empty and private, so nothing the stub writes is made with the
 * command's own umask.
 */
export function makeKept(folder: string = keptFolder()): string {
	mkdirSync(folder, { recursive: true, mode: FOLDER_MODE });
	chmodSync(folder, FOLDER_MODE);
	const path = join(folder, randomUUID());
	for (const suffix of [".out", ".end", ".pid"]) {
		writeFileSync(`${path}${suffix}`, "", { mode: FILE_MODE, flag: "wx" });
	}
	return path;
}

/** A whole number a kept file holds, or nothing while it holds none. */
function numberIn(file: string): number | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		// Not there: the stub hasn't written it, or the call was removed.
		return undefined;
	}
	return /^\d+\n?$/.test(text) ? Number(text.trim()) : undefined;
}

/** The exit status the call's stub wrote as it ended, or nothing yet. */
export function endOf(path: string): number | undefined {
	return numberIn(`${path}.end`);
}

/** The pid of the call's shell, as its stub wrote it first. */
export function pidOf(path: string): number | undefined {
	return numberIn(`${path}.pid`);
}

/** A file's bytes, or none when it isn't there. */
function bytesOf(file: string): Buffer {
	try {
		return readFileSync(file);
	} catch {
		// Never rolled, or already removed.
		return Buffer.alloc(0);
	}
}

/** The call's output, its last `KEPT_BYTES` at most. */
export function outputOf(path: string): string {
	const all = Buffer.concat([bytesOf(`${path}.old`), bytesOf(`${path}.out`)]);
	return all.subarray(Math.max(0, all.length - KEPT_BYTES)).toString("utf8");
}

/**
 * Once `.out` holds more than `cap`, move its last `cap` bytes to `.old`
 * and start it again. tee appends, so it writes on from the start.
 */
export function rollIfFull(path: string, cap: number = KEPT_BYTES): void {
	const out = `${path}.out`;
	try {
		if (statSync(out).size <= cap) return;
		const bytes = readFileSync(out);
		writeFileSync(`${path}.old`, bytes.subarray(bytes.length - cap), {
			mode: FILE_MODE,
		});
		truncateSync(out, 0);
	} catch {
		// Removed under it, as its call ended: nothing left to keep short.
	}
}

/**
 * Mark the call handed to another process, which says its end, with the
 * call's own mark (`PI_BASH_CALL`) when it has one.
 */
export function markCarried(path: string, mark = ""): void {
	try {
		writeFileSync(`${path}${CARRIED}`, mark, { mode: FILE_MODE });
	} catch {
		// Removed under it, as its call ended: nothing left to spare.
	}
}

/** The calls handed to another process, as a reaper tells them apart. */
export interface CarriedCalls {
	/** Their marks, which every process a call starts inherits. */
	readonly marks: ReadonlySet<string>;
	/** Their shells' process groups: each shell leads its own. */
	readonly groups: ReadonlySet<number>;
}

/**
 * The calls in `folder` handed to another process. A call's mark reaches
 * what it started in a group of its own, as `timeout` and `setsid` make;
 * its shell's group covers a call run without one.
 */
export function carriedCalls(folder: string = keptFolder()): CarriedCalls {
	const marks = new Set<string>();
	const groups = new Set<number>();
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// No folder yet: nothing was ever kept, so nothing is carried.
		return { marks, groups };
	}
	for (const name of names) {
		if (!name.endsWith(CARRIED)) continue;
		const path = join(folder, name.slice(0, -CARRIED.length));
		const pid = pidOf(path);
		if (pid !== undefined) groups.add(pid);
		const mark = textOf(`${path}${CARRIED}`).trim();
		if (mark !== "") marks.add(mark);
	}
	return { marks, groups };
}

/** What a kept file holds, or nothing once it is gone. */
function textOf(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		// Removed as its call's end was said: nothing left to spare.
		return "";
	}
}

/** Remove everything a call kept. */
export function removeKept(path: string): void {
	for (const suffix of SUFFIXES) rmSync(`${path}${suffix}`, { force: true });
}

/** Remove the files in `folder` nothing has touched for `olderThanMs`. */
export function sweepKept(
	folder: string = keptFolder(),
	now: number = Date.now(),
	olderThanMs: number = KEPT_FOR_MS,
): void {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// No folder yet: nothing was ever kept.
		return;
	}
	for (const name of names) {
		const file = join(folder, name);
		try {
			if (now - statSync(file).mtimeMs > olderThanMs) rmSync(file);
		} catch {
			// Removed meanwhile by the call it belonged to.
		}
	}
}

/** What {@link teePersists} found, or is finding, by the PATH it was asked with. */
const persistsOn = new Map<string, Promise<boolean>>();

/** How long tee may take to say whether it takes `-p`. */
const TEE_TIMEOUT_MS = 5000;

/**
 * Whether the `tee` that `path` finds writes on to its file once its
 * other output has gone (`-p`, GNU's): without it the stub can't keep a
 * call past its pi, and its calls hold a move, as every call did before.
 * Asked of a command's own PATH, since a hosted conversation's need not
 * be the process's.
 *
 * Asked as each bash call starts, so tee is waited on without holding
 * pi's loop: a host runs every conversation on that loop, and the
 * synchronous ask this was cost one turn 412 ms in a soak of twelve (13
 * November). Each PATH is asked once, its answer shared by every call
 * that asks while tee runs.
 */
export function teePersists(
	path: string | undefined = process.env.PATH,
): Promise<boolean> {
	const key = path ?? "";
	const known = persistsOn.get(key);
	if (known !== undefined) return known;
	const asked = askTee(path);
	persistsOn.set(key, asked);
	return asked;
}

/** Run `tee -p` on empty input, under `path`, and hear whether it took it. */
function askTee(path: string | undefined): Promise<boolean> {
	return new Promise((resolve) => {
		const tee = spawn("tee", ["-p", "/dev/null"], {
			stdio: ["pipe", "ignore", "ignore"],
			timeout: TEE_TIMEOUT_MS,
			...(path === undefined ? {} : { env: { ...process.env, PATH: path } }),
		});
		// No tee on the PATH, or one that could not start: it does not persist.
		tee.once("error", () => resolve(false));
		tee.once("close", (status) => resolve(status === 0));
		tee.stdin?.on("error", () => {
			// A tee that exits before reading leaves the pipe closed; its
			// status still says what it took.
		});
		tee.stdin?.end();
	});
}

/** Whether `shellPath` is bash, whose process substitution the stub needs. */
export function isBash(shellPath: string | undefined): boolean {
	return shellPath === undefined || basename(shellPath) === "bash";
}
