/**
 * Handing sessions to the desktop's launcher to reopen, so one placer
 * puts every window back where it sat: on 30 October six sessions
 * `quest restore` opened itself came out reversed on their workspace.
 * The launcher (core.nix's Quickshell Sessions) takes a JSON object
 * whose `sessions` lists each `{id, cwd}` through
 * `qs ipc call sessions reopen`, and answers "taken", "taken N of M" or
 * "refused: ..." at once. It opens each as
 * `mycelium --realm <its realm> hold -- pi --session <id>`, one at a
 * time, waiting for each window, so only sessions pi saved can go.
 */

import { execFile } from "node:child_process";

/** A session the launcher can reopen: pi saved it, and it has a folder. */
export interface HandedSession {
	readonly id: string;
	readonly cwd: string;
}

/** Runs the launcher's call with its one argument, answering its words. */
export type LauncherCall = (argument: string) => Promise<string>;

/**
 * How long the launcher has to answer. It answers before opening
 * anything, so a shell that takes longer is treated as absent; past it,
 * a late "taken" could open a window twice.
 */
const ANSWER_MS = 10_000;

/** An id the launcher accepts, as its own check has it. */
const LAUNCHER_ID = /^[A-Za-z0-9._-]+$/;

/** Whether the launcher would take this session as given. */
export function launcherTakes(session: HandedSession): boolean {
	return LAUNCHER_ID.test(session.id) && session.cwd.startsWith("/");
}

/**
 * How many sessions the launcher's answer says it took, or undefined
 * when it took none: a refusal, or words it never says.
 */
export function takenBy(answer: string, asked: number): number | undefined {
	const said = answer.trim();
	if (said === "taken") return asked;
	const some = /^taken (\d+) of (\d+)$/.exec(said);
	if (!some) return undefined;
	const taken = Number(some[1]);
	return taken > 0 ? taken : undefined;
}

/** The launcher's own call, through the Quickshell instance running now. */
export const callLauncher: LauncherCall = (argument) =>
	new Promise((resolve, reject) => {
		execFile(
			"qs",
			["ipc", "call", "sessions", "reopen", argument],
			{ timeout: ANSWER_MS },
			(error, stdout) => (error ? reject(error) : resolve(String(stdout))),
		);
	});

/**
 * Hand sessions to the launcher, answering how many it took, or
 * undefined when it took none or didn't answer, which leaves opening
 * them to the caller. Every one given must pass `launcherTakes`.
 */
export async function handOver(
	sessions: readonly HandedSession[],
	call: LauncherCall = callLauncher,
): Promise<number | undefined> {
	if (sessions.length === 0) return undefined;
	const argument = JSON.stringify({
		sessions: sessions.map(({ id, cwd }) => ({ id, cwd })),
	});
	try {
		return takenBy(await call(argument), sessions.length);
	} catch {
		// No shell running, no qs, or no answer in time: the caller opens them.
		return undefined;
	}
}
