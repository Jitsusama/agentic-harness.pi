/**
 * Handing sessions to the desktop's launcher to reopen, so one placer
 * puts every window back where it sat: on 30 October six sessions
 * `quest restore` opened itself came out reversed on their workspace.
 * The launcher (core.nix's Quickshell Sessions) takes a JSON object
 * whose `sessions` lists each `{id, cwd}` through
 * `qs ipc call sessions reopen`, and answers "taken", "taken N of M" or
 * "refused: ..." at once. It opens each as
 * `mycelium --realm <its realm> hold -- pi --session <id>`, one at a
 * time, waiting for each window. One marked `fresh` is started instead
 * as `pi --session-id <id>`, under its `quest` when it names one, so a
 * session pi hasn't saved yet, a new one `quest spawn` starts, can go
 * too (core.nix #1544).
 *
 * "taken" says the shell has the session queued, not that it opened:
 * on 2026-11-04 the shell logged both of two spawns 0.4 s apart and
 * dropped the second from its queue (CFGMMW's finding to Y2YBTS
 * [8a90c5ca]). Each hand-over is its own call with its own argument, so
 * two at once never share one; a spawn whose session never takes its
 * first words is caught by quest-workflow's first-turn-watch.ts.
 *
 * Every one goes with `focus: false`, its quest and the session that
 * asked (`from`), so the launcher opens it without taking focus or
 * switching workspace, where its quest's sessions are, else beside the
 * session that asked: a session that opens a window while the person
 * types into another would take their keys, so only their own press
 * of the launcher focuses one (P9R1KI [e7379980], agreed with Y2YBTS
 * [bb4761d5]).
 *
 * A session handed over while the screen is locked is started behind
 * the lock and placed once it is gone (core.nix #1632), so the hand-over
 * doesn't ask about the lock.
 */

import { execFile } from "node:child_process";

/**
 * A session the launcher can open: one pi saved, or one it starts
 * fresh, in a folder.
 */
export interface HandedSession {
	readonly id: string;
	readonly cwd: string;
	/** Started afresh under `id`, since pi has no record of it to resume. */
	readonly fresh?: boolean;
	/**
	 * The session's quest: the one a fresh session loads as it starts,
	 * and for every session, where the launcher places its window.
	 */
	readonly quest?: string;
	/** The session that asked for it, which the window goes beside. */
	readonly from?: string;
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
		sessions: sessions.map(({ id, cwd, fresh, quest, from }) => ({
			id,
			cwd,
			...(fresh ? { fresh: true } : {}),
			...(quest ? { quest } : {}),
			...(from ? { from } : {}),
			focus: false,
		})),
	});
	try {
		return takenBy(await call(argument), sessions.length);
	} catch {
		// No shell running, no qs, or no answer in time: the caller opens them.
		return undefined;
	}
}
