/**
 * A bash call carried to another process by a move, watched there until
 * it ends, from what it keeps on disk (kept.ts).
 *
 * The process that takes it up is not the shell's parent, so it can't
 * wait on it. It looks each second instead: an exit status in `.end`
 * means the call ended; a shell gone with none means it was lost, killed
 * from outside or with the machine, and is said so with its last lines,
 * never dropped or run again. A stop kills the shell's process group,
 * then everything else carrying its mark, as a stop in its own pi does.
 *
 * A pid is only a number, and one taken up after a restart or a reboot
 * may name another process by then. So a shell counts as there only
 * while its environment, where it can be read, still carries the call's
 * mark; from the first look, as the call is taken up, on.
 */

import { readFileSync } from "node:fs";
import type { CarriedWork } from "../../jobs/index.ts";
import { endOf, outputOf, rollIfFull } from "./kept.ts";
import { CALL_VARIABLE, reap } from "./reap.ts";

/** What a host needs to take up a bash call another pi started. */
export interface CarriedShell extends CarriedWork {
	readonly kind: "shell";
	/** Its kept files' path, without a suffix. */
	readonly keep: string;
	/** Its shell, which leads its process group. */
	readonly pid: number;
	/** The mark everything it started carries. */
	readonly mark: string;
	/** When it started, in milliseconds since the epoch. */
	readonly startedAt: number;
	/** When its time limit runs out, if it had one. */
	readonly deadline?: number;
}

/** Whether carried work is a bash call this code can take up. */
export function isCarriedShell(work: unknown): work is CarriedShell {
	if (typeof work !== "object" || work === null) return false;
	const { kind, keep, pid, mark, startedAt, deadline } = work as Record<
		string,
		unknown
	>;
	return (
		kind === "shell" &&
		typeof keep === "string" &&
		typeof pid === "number" &&
		typeof mark === "string" &&
		typeof startedAt === "number" &&
		(deadline === undefined || typeof deadline === "number")
	);
}

/** How a carried call's watch ended. */
export type CarriedEnd =
	| { readonly how: "exited"; readonly code: number; readonly output: string }
	| { readonly how: "lost"; readonly output: string }
	| { readonly how: "timed-out"; readonly output: string }
	| { readonly how: "stopped" }
	| { readonly how: "handed" };

/** How to look and kill, for tests to stand in for. */
export interface WatchOptions {
	readonly everyMs?: number;
	readonly now?: () => number;
	/** Whether the call's shell is there, as the call it was. */
	readonly alive?: (pid: number, mark: string) => boolean;
	/** Stop the call's work: its group, then its mark. */
	readonly stop?: (work: CarriedShell) => void;
}

/** How often a carried call is looked at. */
export const LOOK_EVERY_MS = 1000;

/** Whether a process is there, ours or not. */
function there(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: there, and somebody else's. ESRCH: gone.
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/**
 * Whether the process `pid` is the call `mark` names: true when its
 * environment carries the mark, false when it carries another, and true
 * when it can't be read (no /proc, or not ours to read), which leaves
 * the pid to say.
 */
export function carriesMark(
	pid: number,
	mark: string,
	read: (file: string) => string = (file) => readFileSync(file, "latin1"),
): boolean {
	let environ: string;
	try {
		environ = read(`/proc/${pid}/environ`);
	} catch {
		// Unreadable: no /proc here, or not ours; the pid alone says.
		return true;
	}
	return environ.split("\0").includes(`${CALL_VARIABLE}=${mark}`);
}

/** Whether the call's shell is there, as the call it was. */
function alive(pid: number, mark: string): boolean {
	return there(pid) && carriesMark(pid, mark);
}

/** Kill a call's process group and everything else it marked. */
export function stopCarried(work: CarriedShell): void {
	try {
		process.kill(-work.pid, "SIGKILL");
	} catch {
		// The group has gone already; its mark may still have stragglers.
	}
	reap(work.mark);
}

/** A carried call's watch: how it ends, and a way to hand it on again. */
export interface CarriedWatch {
	readonly ended: Promise<CarriedEnd>;
	/** It moves again: stop watching, leaving it running. */
	handed(): void;
}

/** Watch a carried call until it ends, `signal` stopping it. */
export function watchCarried(
	work: CarriedShell,
	signal: AbortSignal,
	options: WatchOptions = {},
): CarriedWatch {
	const now = options.now ?? Date.now;
	const isAlive = options.alive ?? alive;
	const stop = options.stop ?? stopCarried;
	let settle: (end: CarriedEnd) => void = () => {};
	const ended = new Promise<CarriedEnd>((resolve) => {
		settle = resolve;
	});
	let clock: ReturnType<typeof setInterval> | undefined;
	const done = (end: CarriedEnd) => {
		clearInterval(clock);
		signal.removeEventListener("abort", stopped);
		settle(end);
	};
	const stopped = () => {
		stop(work);
		done({ how: "stopped" });
	};
	const look = () => {
		rollIfFull(work.keep);
		const code = endOf(work.keep);
		if (code !== undefined) {
			done({ how: "exited", code, output: outputOf(work.keep) });
			return;
		}
		if (!isAlive(work.pid, work.mark)) {
			// It may have written its status as it went, between the looks.
			const last = endOf(work.keep);
			done(
				last === undefined
					? { how: "lost", output: outputOf(work.keep) }
					: { how: "exited", code: last, output: outputOf(work.keep) },
			);
			return;
		}
		if (work.deadline !== undefined && now() >= work.deadline) {
			stop(work);
			done({ how: "timed-out", output: outputOf(work.keep) });
		}
	};
	if (signal.aborted) stopped();
	else {
		signal.addEventListener("abort", stopped, { once: true });
		clock = setInterval(look, options.everyMs ?? LOOK_EVERY_MS);
		clock.unref();
		look();
	}
	return { ended, handed: () => done({ how: "handed" }) };
}
