/**
 * Asking `a-call-is-on` whether the person is on a call, one way for
 * everything that holds work back for one: the machine queue and a
 * prompt cache's warm. It exits 0 while a call is on, 1 while none is,
 * and anything else when it can't tell; 64 says it doesn't take the
 * arguments it was given, as sysexits names a usage error.
 *
 * The answer comes by its own timer, not the program's exit, and a
 * program past its time is killed outright with all it started, as a
 * group of its own: one that ignored a polite stop would otherwise hold
 * its caller waiting, and what it left behind would gather, one more
 * each time it was asked. It runs where pi does, not among the jobs a
 * call holds back, where it would starve behind them.
 *
 * A program that isn't there, or won't take its arguments, can never
 * say a call is on, so whatever it guards is silently off. That is said
 * once per program and arguments, to the first caller that listens.
 */

import { spawn } from "node:child_process";
import { withPi } from "../priority/place.ts";
import { isRecord } from "../record.ts";

/** The program that says whether a call is on. */
const CALL_PROGRAM = "a-call-is-on";

/** The exit a program gives for arguments it doesn't take. */
const REFUSED_EXIT = 64;

/** The programs and arguments whose trouble has been said. */
const said = new Set<string>();

/** How a call is asked about. */
export interface CallAsking {
	/** The program to ask, `a-call-is-on` unless a test names another. */
	readonly program?: string;
	readonly args?: readonly string[];
	/** How long it may take before it counts as unknown. */
	readonly timeoutMs: number;
	/** Hears, once, why the program can't be asked at all. */
	readonly cannotAsk?: (why: string) => void;
}

/**
 * Whether a call is on: true for exit 0, false for 1, and nothing for
 * any other exit, a program that can't start, or one past its time.
 */
export function askCall(asking: CallAsking): Promise<boolean | undefined> {
	const program = asking.program ?? CALL_PROGRAM;
	const args = asking.args ?? [];
	const sayOnce = (why: string) => {
		const key = [program, ...args].join(" ");
		if (asking.cannotAsk === undefined || said.has(key)) return;
		said.add(key);
		asking.cannotAsk(why);
	};
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
			if (isRecord(error) && error.code === "ENOENT") {
				sayOnce(`${program} is not on the PATH`);
			}
			answer(undefined);
		});
		child.once("exit", (code) => {
			if (code === REFUSED_EXIT) {
				sayOnce(`${program} doesn't take ${args.join(" ") || "being asked"}`);
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
