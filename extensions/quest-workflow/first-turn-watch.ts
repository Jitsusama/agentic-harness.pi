/**
 * A spawn looks, a minute on, for the first turn of the session it
 * started, and tells the session that spawned it when there is none.
 * On 11-03 a session spawned for CF3ZG0 sat 44 minutes without a turn
 * and its quest stood still overnight, since nothing noticed
 * (QEST-20261104-ECNIS5). One look a spawn, at the records its first
 * words leave (lib/internal/quest/first-words.ts); a session that took
 * its turn is never mentioned.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { automatedText } from "../../lib/internal/automated.ts";
import {
	type FirstTurn,
	firstTurnOf,
} from "../../lib/internal/quest/first-words.ts";

/** How long a spawned session has to start its first turn. */
export const FIRST_TURN_WATCH_MS = 60_000;

/** A spawn whose session is looked for: the key its words were left under. */
export interface Spawned {
	readonly key: string;
	readonly questId: string;
	/** Its id, when the spawn knows it, as it does for the launcher's. */
	readonly sessionId?: string;
}

/** Looks at the records for the session started under a key. */
export type LookForFirstTurn = (key: string, sessionId?: string) => FirstTurn;

const lookInRecords: LookForFirstTurn = (key, sessionId) =>
	firstTurnOf(key, sessionId ? { sessionId } : {});

/** Looks still to come, so a session that ends takes none with it. */
const watches = new Set<ReturnType<typeof setTimeout>>();

/**
 * The spawn a tool answer describes, when it left words for a session
 * it started: a dry run, or a command that isn't pi, leaves none.
 */
export function spawnedBy(
	action: string,
	details: Record<string, unknown> | undefined,
): Spawned | undefined {
	if (action !== "spawn" && !action.startsWith("spawn-")) return undefined;
	const key = details?.firstWordsKey;
	const questId = details?.autoloadQuestId;
	if (typeof key !== "string" || typeof questId !== "string") return undefined;
	const sessionId = details?.sessionId;
	return {
		key,
		questId,
		...(typeof sessionId === "string" ? { sessionId } : {}),
	};
}

/**
 * Look once, after `afterMs`, for the first turn of the session
 * `spawned` started, and when there is none start a turn here saying
 * which session, on which quest, and what the records show.
 */
export function watchFirstTurn(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	spawned: Spawned,
	look: LookForFirstTurn = lookInRecords,
	afterMs: number = FIRST_TURN_WATCH_MS,
): void {
	const watch = setTimeout(() => {
		watches.delete(watch);
		const turn = look(spawned.key, spawned.sessionId);
		if (turn.started) return;
		const idle = ctx.isIdle?.() ?? true;
		pi.sendUserMessage(
			noTurnWords(spawned, turn, afterMs),
			idle ? undefined : { deliverAs: "followUp" },
		);
	}, afterMs);
	// A look still to come never keeps the process up.
	watch.unref?.();
	watches.add(watch);
}

/** Drop every look still to come, as the session watching ends. */
export function stopFirstTurnWatches(): void {
	for (const watch of watches) clearTimeout(watch);
	watches.clear();
}

/** What the spawner is told when its session took no first turn. */
function noTurnWords(
	spawned: Spawned,
	turn: Extract<FirstTurn, { started: false }>,
	afterMs: number,
): string {
	const session = turn.sessionId ?? spawned.sessionId;
	const which = session
		? `Session ${session}`
		: "The session, an id not yet known,";
	const seconds = Math.round(afterMs / 1000);
	return automatedText(
		"a session this one spawned has not started",
		`${which} that this session spawned on ${spawned.questId} has not started its first turn ${seconds} s after the spawn: ${turn.found}. Find out why and get it working: look at its window and its record under ~/.local/state/pi/agentic-harness.pi/quest-workflow/sessions/, then tell it to carry on, or spawn it again if it never started.`,
	);
}
