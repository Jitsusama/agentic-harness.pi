/**
 * Asking `a-call-is-on` whether the person is on a call, one way for
 * everything that holds work back for one: the machine queue and a
 * prompt cache's warm. It exits 0 while a call is on, 1 while none is,
 * and anything else when it can't tell; 64 says it doesn't take the
 * arguments it was given, as sysexits names a usage error, and 126 or
 * 127 that a shell it runs couldn't run something.
 *
 * The answer comes by its own timer, not the program's exit, and a
 * program past its time is killed outright with all it started, as a
 * group of its own: one that ignored a polite stop would otherwise hold
 * its caller waiting, and what it left behind would gather, one more
 * each time it was asked. It runs where pi does, not among the jobs a
 * call holds back, where it would starve behind them.
 *
 * A program that can't be asked can never say a call is on, so whatever
 * it guards is off. Each ask says why to its caller, which decides how
 * often to tell someone and whom: a process may hold several
 * conversations, and each has its own person to tell.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { delimiter, join } from "node:path";
import { withPi } from "../priority/place.ts";
import { isRecord } from "../record.ts";

/** The program that says whether a call is on. */
const CALL_PROGRAM = "a-call-is-on";

/** The exit a program gives for arguments it doesn't take. */
const REFUSED_EXIT = 64;

/** The exits a shell gives for a command it couldn't run or find. */
const BROKEN_EXITS: ReadonlySet<number | null> = new Set([126, 127]);

/**
 * The spawn errors that say the program itself can't be run, as against
 * a machine short of processes or files for now (EAGAIN, EMFILE, ENFILE,
 * ENOMEM), which says nothing about the program and passes. Node emits
 * EACCES as an error but throws the others from spawn itself.
 */
const UNRUNNABLE: ReadonlySet<string> = new Set([
	"EACCES",
	"ENOEXEC",
	"EISDIR",
	"ENOTDIR",
	"ELOOP",
	"EPERM",
]);

/**
 * Why a call can't be asked about: the program isn't there, it refuses
 * its arguments, or it is there but can't run.
 */
export interface CallTrouble {
	readonly kind: "missing" | "refused" | "broken";
	readonly why: string;
}

/** How a call is asked about. */
export interface CallAsking {
	/** The program to ask, `a-call-is-on` unless a test names another. */
	readonly program?: string | undefined;
	readonly args?: readonly string[];
	/** How long it may take before it counts as unknown. */
	readonly timeoutMs: number;
	/** Hears, on each ask that meets it, why the program can't be asked. */
	readonly cannotAsk?: ((trouble: CallTrouble) => void) | undefined;
}

/**
 * Whether a call is on: true for exit 0, false for 1, and nothing for
 * any other exit, a program that can't start, or one past its time.
 */
export function askCall(asking: CallAsking): Promise<boolean | undefined> {
	const program = asking.program ?? CALL_PROGRAM;
	const args = asking.args ?? [];
	const tell = (trouble: CallTrouble | undefined) => {
		if (trouble === undefined) return;
		try {
			asking.cannotAsk?.(trouble);
		} catch {
			// A hearer that fails can't unsay the answer, already given, or
			// throw from an emitter's listener into the process holding it.
		}
	};
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = withPi(() =>
				spawn(program, args, { stdio: "ignore", detached: true }),
			);
		} catch (error) {
			resolve(undefined);
			tell(startTrouble(program, error));
			return;
		}
		const late = setTimeout(() => {
			killGroup(child.pid);
			resolve(undefined);
		}, asking.timeoutMs);
		late.unref();
		const answer = (onCall: boolean | undefined) => {
			clearTimeout(late);
			resolve(onCall);
		};
		child.once("error", (error) => {
			answer(undefined);
			tell(startTrouble(program, error));
		});
		child.once("exit", (code) => {
			answer(code === 0 ? true : code === 1 ? false : undefined);
			tell(exitTrouble(program, args, code));
		});
	});
}

/** Why `program` couldn't be started, from the error its spawn gave. */
function startTrouble(
	program: string,
	error: unknown,
): CallTrouble | undefined {
	const code = isRecord(error) ? error.code : undefined;
	if (typeof code !== "string") return undefined;
	if (code !== "ENOENT" && !UNRUNNABLE.has(code)) return undefined;
	// A PATH folder it can't search, or a file listed as one, fails the
	// way a program that can't run does; only something there is broken.
	if (!isThere(program)) {
		return { kind: "missing", why: `${program} isn't on the PATH` };
	}
	if (code === "ENOENT") {
		return {
			kind: "broken",
			why: `${program} is there, but what it runs isn't`,
		};
	}
	return { kind: "broken", why: `${program} can't be started (${code})` };
}

/** Why `program` couldn't answer, from its exit. */
function exitTrouble(
	program: string,
	args: readonly string[],
	code: number | null,
): CallTrouble | undefined {
	if (code === REFUSED_EXIT) {
		return {
			kind: "refused",
			why:
				args.length > 0
					? `${program} doesn't take ${args.join(" ")}`
					: `${program} refuses to answer with no arguments`,
		};
	}
	if (BROKEN_EXITS.has(code)) {
		return {
			kind: "broken",
			why: `${program} couldn't run what it needs (exit ${code})`,
		};
	}
	return undefined;
}

/**
 * Whether `program` is there, where a spawn would look: itself when it
 * names a path, else in each folder on the PATH. A link to nothing
 * counts, since something was put there to be run.
 */
function isThere(program: string): boolean {
	const candidates = program.includes("/")
		? [program]
		: (process.env.PATH ?? "")
				.split(delimiter)
				.filter(Boolean)
				.map((dir) => join(dir, program));
	return candidates.some((candidate) => {
		try {
			lstatSync(candidate);
			return true;
		} catch {
			// Nothing of that name in this folder; the next may hold it.
			return false;
		}
	});
}

/** Kills the process group `pid` leads, which it does as one detached. */
function killGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// ESRCH: the group has already gone, which is all the kill was for.
	}
}
