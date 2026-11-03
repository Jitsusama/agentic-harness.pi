/**
 * Handing a spawned session to the desktop's launcher, as `quest
 * restore` hands it the sessions it reopens (hand-over.ts), so one
 * placer puts every pi window on the screen rather than two that don't
 * know of each other. The launcher opens a kitty window held in the
 * machine's realm, so only a spawn that would open just that goes to
 * it: plain pi, here, in a kitty window the call didn't name a
 * terminal, layout or nesting for. Anything else, or a launcher that
 * doesn't answer, opens as it always has.
 */

import {
	callLauncher,
	type HandedSession,
	handOver,
	type LauncherCall,
	launcherTakes,
} from "../../../lib/internal/quest/hand-over.ts";
import { realmSegments } from "../../../lib/internal/realm.ts";
import { uuidv7 } from "../../../lib/internal/session/rollover.ts";
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
	/** The session the spawn resumes, when it resumes one. */
	readonly resumedSessionId?: string;
	/** Whether the call named a terminal, a layout or a nesting. */
	readonly named: boolean;
	/** The session asking for it, which its window goes beside. */
	readonly fromSessionId?: string;
}

/**
 * The session a spawn would hand the launcher, or undefined when it
 * opens its own terminal: when the call named where it opens, in a realm
 * other than the machine's home one (the launcher holds what it opens
 * there), with `PI_LAUNCHER=off` as the test suite sets it, or for a
 * command other than pi resuming or starting. A new session is given an
 * id now, since the launcher starts it under one.
 */
export function launcherSession(
	spawn: LauncherSpawn,
): HandedSession | undefined {
	if (spawn.named || realmSegments().length > 0) return undefined;
	if (process.env.PI_LAUNCHER === "off") return undefined;
	const resumed = spawn.resumedSessionId;
	// Its quest and the session asking say where its window goes.
	const placed = {
		cwd: spawn.cwd,
		quest: spawn.questId,
		...(spawn.fromSessionId ? { from: spawn.fromSessionId } : {}),
	};
	const session: HandedSession | undefined =
		resumed !== undefined && spawn.command === `pi --session ${resumed}`
			? { id: resumed, ...placed }
			: spawn.command === "pi"
				? { id: uuidv7(), fresh: true, ...placed }
				: undefined;
	return session && launcherTakes(session) ? session : undefined;
}

/** Whether a plan opens what the launcher would: a kitty window. */
export function launcherOpens(plan: TerminalPlan): boolean {
	return plan.terminal === "kitty" && plan.layout === "window";
}

/**
 * Hand the session to the launcher when the settings would open it in a
 * kitty window anyway, answering whether the launcher took it. A plan
 * that can't be made, or one for another terminal or layout, is left to
 * the caller to open, which says why as it always has.
 */
export async function spawnedByLauncher(
	session: HandedSession,
	request: OpenRequest,
	options: OpenOptions,
	call: LauncherCall = callLauncher,
): Promise<boolean> {
	let plan: TerminalPlan;
	try {
		plan = (await openTerminal(request, { ...options, dryRun: true })).plan;
	} catch {
		// No plan: the caller's own open reports what stops it.
		return false;
	}
	if (!launcherOpens(plan)) return false;
	return (await handOver([session], call)) === 1;
}
