/**
 * Handing a spawned session to the desktop's launcher, as `quest
 * restore` hands it the sessions it reopens (hand-over.ts), so one
 * placer puts every pi window on the screen rather than two that don't
 * know of each other. The launcher opens a kitty window held in the
 * machine's realm, so only a spawn that would open just that goes to
 * it: plain pi, here, in a kitty window the call didn't name a
 * terminal, layout or nesting for. Anything else opens as it always
 * has. One the launcher would open but doesn't take opens in the
 * desktop's sessions kitty instead, where the launcher's own go
 * (sessions-kitty.ts), and one it never answered is left with it.
 */

import {
	askLauncher,
	callLauncher,
	type HandedPlace,
	type HandedSession,
	type LauncherCall,
	launcherTakes,
} from "../../../lib/internal/quest/hand-over.ts";
import { realmSegments } from "../../../lib/internal/realm.ts";
import { uuidv7 } from "../../../lib/internal/session/uuidv7.ts";
import {
	type OpenOptions,
	type OpenRequest,
	openTerminal,
	type TerminalPlan,
} from "../../../lib/terminal/index.ts";

/** What a spawn opens, as far as the launcher cares. */
export interface LauncherSpawn {
	/** The command the spawn runs, after the realm's agent command. */
	readonly command: string;
	readonly cwd: string;
	readonly questId: string;
	/** Whether the call named a terminal, a layout or a nesting. */
	readonly named: boolean;
	/** The session asking for it, which its window goes beside. */
	readonly fromSessionId?: string;
	/** The orchestrator, workspace and title its window is placed by (window-place.ts). */
	readonly place?: HandedPlace;
}

/**
 * `pi --session <id>`, alone or with the model to run it on: what a
 * restart asks for, since orchestrators restart a session under a new
 * holder as `pi --session <id> --model <model>`. Anything more is the
 * caller's own and opens as it says; a log's path in place of an id is
 * turned away by `launcherTakes`.
 */
const RESUMING = /^pi --session (\S+)(?: --model (\S+))?$/;

/** A new pi, alone or with the model to start it on. */
const STARTING = /^pi(?: --model (\S+))?$/;

/** The session a command resumes and the model it names, if it only resumes. */
export function resumedBy(
	command: string,
): { id: string; model?: string } | undefined {
	const [, id, model] = RESUMING.exec(command.trim()) ?? [];
	if (id === undefined) return undefined;
	return model ? { id, model } : { id };
}

/**
 * The session a spawn would hand the launcher, or undefined when it
 * opens its own terminal: when the call named where it opens, in a realm
 * other than the machine's home one (the launcher holds what it opens
 * there), with `PI_LAUNCHER=off` as the test suite sets it, or for a
 * command other than pi resuming or starting. A new session is given an
 * id now, since the launcher starts it under one. A resumed one says it
 * takes its own place, so the launcher opens it where its window was.
 */
export function launcherSession(
	spawn: LauncherSpawn,
): HandedSession | undefined {
	if (spawn.named || realmSegments().length > 0) return undefined;
	if (process.env.PI_LAUNCHER === "off") return undefined;
	const resumed = resumedBy(spawn.command);
	const [starting, model] = STARTING.exec(spawn.command.trim()) ?? [];
	// Its quest, its orchestrator and title, and the session asking say
	// where its window goes.
	const placed = {
		cwd: spawn.cwd,
		quest: spawn.questId,
		...(spawn.fromSessionId ? { from: spawn.fromSessionId } : {}),
		...spawn.place,
	};
	const session: HandedSession | undefined = resumed
		? {
				id: resumed.id,
				replaces: resumed.id,
				...(resumed.model ? { model: resumed.model } : {}),
				...placed,
			}
		: starting !== undefined
			? { id: uuidv7(), fresh: true, ...(model ? { model } : {}), ...placed }
			: undefined;
	return session && launcherTakes(session) ? session : undefined;
}

/** Whether a plan opens what the launcher would: a kitty window. */
export function launcherOpens(plan: TerminalPlan): boolean {
	return plan.terminal === "kitty" && plan.layout === "window";
}

/**
 * What handing a spawn to the launcher came to: taken, or left with a
 * shell too busy to answer, are both the launcher's to open; untaken is
 * a kitty window it would have opened but didn't take; unasked, a spawn
 * it doesn't open at all.
 */
export type LauncherSpawned = "taken" | "unanswered" | "untaken" | "unasked";

/**
 * Hand the session to the launcher when the settings would open it in a
 * kitty window anyway, answering what that came to. A plan that can't be
 * made, or one for another terminal or layout, is left to the caller to
 * open, which says why as it always has.
 */
export async function spawnedByLauncher(
	session: HandedSession,
	request: OpenRequest,
	options: OpenOptions,
	call: LauncherCall = callLauncher,
): Promise<LauncherSpawned> {
	let plan: TerminalPlan;
	try {
		plan = (await openTerminal(request, { ...options, dryRun: true })).plan;
	} catch {
		// No plan: the caller's own open reports what stops it.
		return "unasked";
	}
	if (!launcherOpens(plan)) return "unasked";
	const answer = await askLauncher([session], call);
	if (answer === "unanswered" || answer === "untaken") return answer;
	return answer.taken === 1 ? "taken" : "untaken";
}
