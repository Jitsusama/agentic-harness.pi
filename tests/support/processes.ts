/**
 * Asking the machine about processes, for tests that need a real one.
 *
 * Here rather than in each file because there are now three answers to
 * the same question across two directories, and the question is one
 * where a wrong answer signals a process nobody meant to touch.
 */

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
	const until = Date.now() + withinMs;
	while (Date.now() < until) {
		try {
			process.kill(pid, 0);
		} catch {
			// Nobody is wearing it, which is the whole assertion.
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`${pid} was still running after ${withinMs}ms`);
}
