/**
 * A fenced language server's process, as pi ends it and hears it.
 *
 * A fenced server runs in a process group of its own: the fence's
 * shell, the sandbox and the server inside it. pi ends that group as
 * one, and keeps what it last said on its error output for a start
 * that fails.
 */

import type { ChildProcess } from "node:child_process";

/** The status the fence's own refusal exits with (`refusedCommand`). */
export const FENCE_REFUSED = 126;

/** How long a fenced server's group has to end once told, before it is killed. */
export const END_GRACE_MS = 5000;

/** The most of a fenced server's error output kept for its start's error. */
const SAID_MOST = 2000;

/** How long a failed start waits for the rest of the server's error output. */
const SAID_WAIT_MS = 1000;

/**
 * Ends a fenced server's whole process group: the shell, the sandbox
 * and the server inside it. Told first, so the shell can finish what
 * the fence runs after its command; what is left `graceMs` later is
 * killed, so nothing that ignores the telling outlives the server.
 * It ends the group once, however many ways the server is ended, so
 * no later kill reaches a group id the system has since given out.
 */
export function groupEnder(child: ChildProcess, graceMs: number): () => void {
	let told = false;
	const signal = (sent: NodeJS.Signals): void => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, sent);
			else child.kill(sent);
		} catch {
			// The group is gone already; the shell alone may be left.
			child.kill(sent);
		}
	};
	return () => {
		if (told) return;
		told = true;
		signal("SIGTERM");
		setTimeout(() => signal("SIGKILL"), graceMs).unref();
	};
}

/**
 * The status the child exited with, once it has, or a moment has
 * passed; undefined while it runs. Its error output can close before
 * the exit is heard, so a start that fails waits on both.
 */
export function exitOf(
	child: ChildProcess,
): () => Promise<{ readonly code: number | null } | undefined> {
	const exited = new Promise<{ readonly code: number | null }>((resolve) => {
		if (child.exitCode !== null) resolve({ code: child.exitCode });
		child.once("exit", (code) => resolve({ code }));
	});
	return () => within(exited, SAID_WAIT_MS);
}

/** What `promise` settles to within `ms`, or undefined. */
async function within<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * What the child last wrote on its error output, its tail kept, read
 * once that output closes or a moment has passed. Its own output, not
 * the child's every stream: the fence's watcher holds the fourth pipe
 * until the group is killed, but never the error output.
 */
export function lastSaid(child: ChildProcess): () => Promise<string> {
	let said = "";
	// Decoded as a stream, so a character split across chunks stays whole.
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		said = (said + chunk).slice(-SAID_MOST);
	});
	const closed = new Promise<void>((resolve) => {
		if (!child.stderr) resolve();
		child.stderr?.once("close", () => resolve());
	});
	return async () => {
		await within(closed, SAID_WAIT_MS);
		return said;
	};
}
