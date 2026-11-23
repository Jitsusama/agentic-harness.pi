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

import { spawn } from "node:child_process";
import { withPi } from "../priority/place.ts";
import { isRecord } from "../record.ts";

/** The program that says whether a call is on. */
const CALL_PROGRAM = "a-call-is-on";

/** The exit a program gives for arguments it doesn't take. */
const REFUSED_EXIT = 64;

/** The exits a shell gives for a command it couldn't run or find. */
const BROKEN_EXITS: ReadonlySet<number | null> = new Set([126, 127]);

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
	const trouble = (kind: CallTrouble["kind"], why: string) =>
		asking.cannotAsk?.({ kind, why });
	return new Promise((resolve) => {
		const child = withPi(() =>
			spawn(program, args, { stdio: "ignore", detached: true }),
		);
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
			const code = isRecord(error) ? error.code : undefined;
			if (code === "ENOENT") {
				trouble(
					"missing",
					`${program} isn't on the PATH, or the interpreter it names isn't there`,
				);
			} else {
				trouble("broken", `${program} can't be started (${String(code)})`);
			}
			answer(undefined);
		});
		child.once("exit", (code) => {
			if (code === REFUSED_EXIT) {
				trouble(
					"refused",
					args.length > 0
						? `${program} doesn't take ${args.join(" ")}`
						: `${program} refuses to answer with no arguments`,
				);
			} else if (BROKEN_EXITS.has(code)) {
				trouble(
					"broken",
					`${program} couldn't run what it needs (exit ${code})`,
				);
			}
			answer(code === 0 ? true : code === 1 ? false : undefined);
		});
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
