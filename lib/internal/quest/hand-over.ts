/**
 * Handing sessions to the desktop's launcher to reopen, so one placer
 * puts every window back where it sat: on 30 October six sessions
 * `quest reopen-sessions` opened itself came out reversed on their workspace.
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
 * Each says too the orchestrator its presence will name and the title
 * its window will read, so the launcher opens a session on its
 * orchestrator's workspace at its place by title from the first, rather
 * than beside whoever asked and moved after: on 8 November a session
 * spawned for 91DWO8 by WCJQSG opened on WCJQSG's workspace (Y2YBTS
 * [75db8bd0]).
 *
 * A session handed over while the screen is locked is started behind
 * the lock and placed once it is gone (core.nix #1632), so the hand-over
 * doesn't ask about the lock.
 *
 * A launcher that doesn't answer in time is busy, not gone: at 13:28 on
 * 10 November the shell's GUI thread was held up, the call ran out, and
 * two spawns opened plain kitty windows of their own, outside the
 * sessions kitty (Y2YBTS [9f93dcd0]). The call it was sent still sits
 * with the shell, so asking again, or opening the window elsewhere,
 * could open the session twice. An unanswered hand-over is taken as
 * taken, said apart, and the spawn's first-turn watch looks for the
 * session it opens. Only a launcher that isn't there or refuses leaves
 * the session to the caller.
 */

import { execFile } from "node:child_process";
import type { CarriedEnvironment } from "../session/carried-environment.ts";

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
	/**
	 * The address of the orchestrator its presence will say, as
	 * `91DWO8`, whose workspace its window opens on. Absent for a
	 * session nothing orchestrates.
	 */
	readonly orchestratedBy?: string;
	/**
	 * The niri workspace its window opens on, by name: the address of the
	 * topmost orchestrator over its quest, else its quest's own (see
	 * windowWorkspaceOf in orchestration.ts). Never an id or a position,
	 * which a boot changes (KP0L6A, 13 November). Absent with no quest.
	 */
	readonly workspace?: string;
	/**
	 * Its title as its window will read, without pi's "π - " before it or
	 * " - <folder>" after it, for its place among its orchestrator's.
	 */
	readonly title?: string;
	/**
	 * The session whose window this one takes the place of: itself, for a
	 * session restored or resumed, so the launcher opens it where that
	 * window was rather than beside whoever asked. Absent for a new one.
	 */
	readonly replaces?: string;
	/**
	 * The model the session runs on, as `pi --model` names it: a new one's,
	 * or a resumed one's for a restart that names one. Absent, a new session
	 * starts on pi's default and a resumed one on what its log says.
	 */
	readonly model?: string;
	/**
	 * What it was started with that says how its commands run, in the
	 * agent fence and through the spawner, each a plain word, for the
	 * launcher to start it with again behind `env`. Absent, it starts as
	 * the launcher's own shell would.
	 */
	readonly env?: CarriedEnvironment;
}

/** Runs the launcher's call with its one argument, answering its words. */
export type LauncherCall = (argument: string) => Promise<string>;

/**
 * How long the launcher has to answer. It answers before opening
 * anything, so this is how long its shell may be busy; past it, the
 * call is left with the shell, unanswered.
 */
const ANSWER_MS = 30_000;

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
 * What a hand-over came to: how many the launcher took, that its call
 * ran out of time with the shell still holding it, or that it took none
 * (refused, or no shell or `qs` to ask).
 */
export type HandOverAnswer =
	| { readonly taken: number }
	| "unanswered"
	| "untaken";

/** Whether a call failed by running out of time, as execFile's timeout kills it. */
function ranOut(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"killed" in error &&
		error.killed === true
	);
}

/**
 * Hand sessions to the launcher, answering how many it took, or
 * undefined when it took none, which leaves opening them to the caller.
 * One it never answered counts as taking them all (see above). Every one
 * given must pass `launcherTakes`.
 */
export async function handOver(
	sessions: readonly HandedSession[],
	call: LauncherCall = callLauncher,
): Promise<number | undefined> {
	const answer = await askLauncher(sessions, call);
	if (answer === "unanswered") return sessions.length;
	return answer === "untaken" ? undefined : answer.taken;
}

/**
 * What a session's window is placed by: the orchestrator its presence
 * says, the workspace it opens on and its title (window-place.ts).
 */
export type HandedPlace = Pick<
	HandedSession,
	"orchestratedBy" | "workspace" | "title"
>;

/** Hand sessions to the launcher, answering what it came to. */
export async function askLauncher(
	sessions: readonly HandedSession[],
	call: LauncherCall = callLauncher,
): Promise<HandOverAnswer> {
	if (sessions.length === 0) return "untaken";
	const argument = JSON.stringify({
		sessions: sessions.map(
			({
				id,
				cwd,
				fresh,
				quest,
				from,
				orchestratedBy,
				workspace,
				title,
				replaces,
				model,
				env,
			}) => ({
				id,
				cwd,
				...(fresh ? { fresh: true } : {}),
				...(quest ? { quest } : {}),
				...(from ? { from } : {}),
				...(orchestratedBy ? { orchestratedBy } : {}),
				...(workspace ? { workspace } : {}),
				...(title ? { title } : {}),
				...(replaces ? { replaces } : {}),
				...(model ? { model } : {}),
				...(env ? { env } : {}),
				focus: false,
			}),
		),
	});
	let said: string;
	try {
		said = await call(argument);
	} catch (error) {
		// No answer in time leaves the call with a busy shell; no shell
		// running, or no qs, leaves the sessions to the caller.
		return ranOut(error) ? "unanswered" : "untaken";
	}
	const taken = takenBy(said, sessions.length);
	return taken === undefined ? "untaken" : { taken };
}
