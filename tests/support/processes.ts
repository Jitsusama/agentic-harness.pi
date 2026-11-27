/**
 * Asking the machine about processes, for tests that need a real one.
 *
 * Here rather than in each file because there are now three answers to
 * the same question across two directories, and the question is one
 * where a wrong answer signals a process nobody meant to touch.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { until } from "./until.ts";

/** Where a machine shows each process's own files: Linux's /proc, which a Mac lacks, asking ps(1) instead. */
const PROC = "/proc";
/** ps's RSS column, in KB on Linux and a Mac alike. */
const KB_PER_MB = 1024;

/**
 * A pid nothing is wearing.
 *
 * Asked rather than assumed. A number picked out of the air is one the
 * machine may well have handed to something, and a lease naming a live
 * stranger is how a test comes to kill a process it knows nothing
 * about.
 */
export function noSuchProcess(): number {
	for (let pid = 60_000; pid < 70_000; pid++) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			// ESRCH is nobody. EPERM is somebody we may not signal,
			// which is still somebody.
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
		}
	}
	throw new Error("every pid probed was in use, which cannot be right");
}

/** Wait for a process to go, or give up saying it never did. */
export async function gone(pid: number, withinMs: number): Promise<void> {
	await until(`${pid} to stop running`, () => !answers(pid), withinMs);
}

/**
 * Wait until /proc shows `pid` running `program`, where there is a
 * /proc. A spawn returns once the child's exec has begun, but its
 * command line and environment read empty there until the exec has
 * laid them out, so a test that reads a fresh child's mark at once can
 * find none on a loaded machine.
 */
export async function execed(pid: number, program: string): Promise<void> {
	const cmdline = `/proc/${pid}/cmdline`;
	if (!existsSync("/proc/self")) return;
	await until(`${pid} to run ${program}`, () =>
		readFileSync(cmdline, "latin1").startsWith(`${program}\0`),
	);
}

/**
 * The first process `parent` started, once it has: from /proc where
 * there is one, else from pgrep(1), which a Mac has.
 */
export function childOf(parent: number): number | undefined {
	if (!existsSync(`${PROC}/self`)) {
		const [first] = words(
			spawnSync("pgrep", ["-P", String(parent)], { encoding: "utf8" }).stdout ??
				"",
		);
		return first === undefined ? undefined : Number(first);
	}
	try {
		const [first] = words(
			readFileSync(`${PROC}/${parent}/task/${parent}/children`, "utf8"),
		);
		return first === undefined ? undefined : Number(first);
	} catch {
		// It hasn't forked yet, or has ended: whoever polls asks again.
		return undefined;
	}
}

/**
 * How much memory `pid` holds now, in MB: /proc's VmRSS where there is
 * one, else ps(1)'s RSS, the same count. A process that never started
 * (no pid) holds none to read, which is refused.
 */
export function residentMb(pid: number | undefined): number {
	if (pid === undefined) throw new Error("no pid to read memory of");
	if (!existsSync(`${PROC}/self`)) {
		const kb = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
			encoding: "utf8",
		}).stdout?.trim();
		if (!kb || !/^\d+$/.test(kb)) throw new Error(`ps gave no RSS for ${pid}`);
		return Number(kb) / KB_PER_MB;
	}
	const status = readFileSync(`${PROC}/${pid}/status`, "utf8");
	const kb = /^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1];
	if (kb === undefined) throw new Error(`no VmRSS for ${pid}: ${status}`);
	return Number(kb) / KB_PER_MB;
}

/**
 * A process of this account's running `command` with `entry`
 * (NAME=value) in its environment: read from /proc where there is one,
 * whose command line must be `command` exactly, else from ps(1)'s
 * listing with environments, as a Mac gives it, as `runningIn` reads it.
 */
export function runningWith(
	command: readonly string[],
	entry: string,
): number | undefined {
	if (!existsSync(`${PROC}/self`)) {
		const listing = spawnSync("ps", ["-wwE", "-A", "-o", "pid=,command="], {
			encoding: "utf8",
			maxBuffer: 64 * KB_PER_MB * KB_PER_MB,
		}).stdout;
		return runningIn(listing ?? "", command, entry);
	}
	const line = `${command.join("\0")}\0`;
	for (const name of readdirSync(PROC)) {
		const pid = Number(name);
		if (!Number.isInteger(pid)) continue;
		try {
			if (readFileSync(`${PROC}/${pid}/cmdline`, "utf8") !== line) continue;
			const env = readFileSync(`${PROC}/${pid}/environ`, "utf8").split("\0");
			if (env.includes(entry)) return pid;
		} catch {
			// Gone, or another account's: not the process asked about.
		}
	}
	return undefined;
}

/**
 * The first pid in a ps(1) listing of `pid command` lines, environments
 * shown (BSD ps's -E puts them after the command's words), whose words
 * begin with `command`'s, with `entry` among the words after them. The
 * listing can't tell an argument from an environment entry, so a
 * command carrying more words matches too: `entry`, a case's own HOME,
 * is what picks the process. An argument or a value holding a space
 * reads as two words, so a command is matched only when its own words
 * and `entry` hold none.
 */
export function runningIn(
	listing: string,
	command: readonly string[],
	entry: string,
): number | undefined {
	for (const line of listing.split("\n")) {
		const [pid, ...rest] = words(line);
		if (pid === undefined || !/^\d+$/.test(pid)) continue;
		if (command.some((word, at) => rest[at] !== word)) continue;
		if (rest.slice(command.length).includes(entry)) return Number(pid);
	}
	return undefined;
}

/** The words of `text`, split at whitespace, none empty. */
function words(text: string): string[] {
	return text
		.trim()
		.split(/\s+/)
		.filter((one) => one !== "");
}

/** Whether something still wears `pid`, as a signal of none tells. */
export function alive(pid: number): boolean {
	return answers(pid);
}

/** Whether something still wears `pid`. */
function answers(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// Nobody is wearing it, which is the whole assertion.
		return false;
	}
}
