/**
 * Asking the machine about processes, for tests that need a real one.
 *
 * Here rather than in each file because there are now three answers to
 * the same question across two directories, and the question is one
 * where a wrong answer signals a process nobody meant to touch.
 */

import { existsSync, readFileSync } from "node:fs";
import { until } from "./until.ts";

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
