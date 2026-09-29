/**
 * Running git and gh with nobody at the keyboard, in pi's exec's shape.
 *
 * Pi's exec shares pi's terminal with the child and tells it nothing, so a
 * git wanting a password or a gh wanting a login drew its prompt over pi's
 * interface and waited for keys that never reached it. Core's spawnExec
 * runs the child in a session of its own, tells git and gh not to ask,
 * and stops it with its signal or its clock; this is that, answering the
 * way pi's exec answers, so it goes wherever a host's exec did.
 *
 * Shared by the review and work integrations, which must not import each
 * other, so it lives here rather than in either.
 */

import type {
	ExecOptions,
	ExecResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	EXIT_ABORTED,
	EXIT_TIMED_OUT,
	type Exec,
	spawnExec,
} from "@jitsusama/agentic-harness.core/exec";

/**
 * How long one command may run when its caller names no clock.
 *
 * Ten minutes, longer than any fetch or push here has taken and shorter
 * than forever: it ends a wait that will never finish, it is not a budget
 * on honest work.
 */
export const UNATTENDED_LIMIT_MS = 10 * 60 * 1000;

/**
 * The library's exec seam, run unattended: stopped by `signal` when one is
 * given, and by the unattended clock either way.
 */
export function unattendedExec(signal?: AbortSignal): Exec {
	return spawnExec({
		...(signal ? { signal } : {}),
		timeoutMs: UNATTENDED_LIMIT_MS,
	});
}

/** Run a command that cannot prompt, and cannot outlive its signal or clock. */
export async function execUnattended(
	command: string,
	args: string[],
	options: ExecOptions = {},
): Promise<ExecResult> {
	const exec = spawnExec({
		...(options.signal ? { signal: options.signal } : {}),
		...(options.cwd ? { cwd: options.cwd } : {}),
		timeoutMs: options.timeout ?? UNATTENDED_LIMIT_MS,
	});
	const result = await exec(command, args);
	return {
		...result,
		killed: result.code === EXIT_ABORTED || result.code === EXIT_TIMED_OUT,
	};
}

/** A host whose exec is `execUnattended`, for what takes a host to ask. */
export const UNATTENDED_HOST: Pick<ExtensionAPI, "exec"> = {
	exec: execUnattended,
};
