/**
 * A spawn looks, a minute on, for the first turn of the session it
 * started, and tells the session that spawned it when there is none.
 * On 11-03 a session spawned for CF3ZG0 sat 44 minutes without a turn
 * and its quest stood still overnight, since nothing noticed
 * (QEST-20261104-ECNIS5). One look a spawn, at the records its first
 * words leave (lib/internal/quest/first-words.ts); a session that took
 * its turn is never mentioned.
 *
 * A start can outlast the minute: on 11-04 at 17:05 a spawn's pi took
 * 77 s to start at CPU pressure 80%, and the look told its spawner it
 * never had. So while its words still wait and a process naming its
 * session runs, the look comes again each minute, telling only once
 * MOST_START_MS has passed.
 */

import { readdirSync, readFileSync } from "node:fs";

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

/**
 * The longest a spawned session's pi may still be starting before its
 * spawner is told, though the pi runs: past this it is stuck, as
 * CF3ZG0's pi was, running a command that never took its words.
 */
export const MOST_START_MS = 5 * 60_000;

/** A spawn whose session is looked for: the key its words were left under. */
export interface Spawned {
	readonly key: string;
	readonly questId: string;
	/** Its id, when the spawn knows it, as it does for the launcher's. */
	readonly sessionId?: string;
	/** The folder whose trust prompt its pi stops at, when the spawn said so. */
	readonly trustWaits?: string;
}

/**
 * Looks at the records for the session a spawn started, counting only
 * a turn taken `since` the spawn (epoch ms).
 */
export type LookForFirstTurn = (spawned: Spawned, since: number) => FirstTurn;

const lookInRecords: LookForFirstTurn = ({ key, sessionId }, since) =>
	firstTurnOf(key, { since, ...(sessionId ? { sessionId } : {}) });

/** Whether the pi a spawn started is running, so may still be starting. */
export type PiRuns = (spawned: Spawned) => boolean;

/**
 * Whether any process's command line names the spawned session, as
 * its pi's and its holder's do (`--session-id <id>`). Without the id,
 * or without /proc to read, none is known to run.
 */
export const piRunsFor: PiRuns = ({ sessionId }) => {
	if (!sessionId) return false;
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	} catch {
		// No /proc, as on macOS: the look tells at its first minute, as before.
		return false;
	}
	return pids.some((pid) => {
		try {
			return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(sessionId);
		} catch {
			// The process ended between the listing and the read.
			return false;
		}
	});
};

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
	const trustWaits = details?.trustWaits;
	return {
		key,
		questId,
		...(typeof sessionId === "string" ? { sessionId } : {}),
		...(typeof trustWaits === "string" ? { trustWaits } : {}),
	};
}

/**
 * Look, after `afterMs`, for the first turn of the session `spawned`
 * started, and when there is none start a turn here saying which
 * session, on which quest, and what the records show. While its words
 * still wait and its pi runs, look again each `afterMs` instead, up to
 * MOST_START_MS, unless the spawn said its pi waits at the folder-trust
 * prompt: a pi waiting there runs and still hasn't taken its words, and
 * will wait as long as nobody answers.
 */
export function watchFirstTurn(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	spawned: Spawned,
	look: LookForFirstTurn = lookInRecords,
	afterMs: number = FIRST_TURN_WATCH_MS,
	runs: PiRuns = piRunsFor,
): void {
	const spawnedAt = Date.now();
	const lookAfter = (waited: number) => {
		const watch = setTimeout(
			() => {
				watches.delete(watch);
				const turn = look(spawned, spawnedAt);
				if (turn.started) return;
				if (
					turn.waiting &&
					!spawned.trustWaits &&
					waited < MOST_START_MS &&
					runs(spawned)
				) {
					lookAfter(Math.min(waited + afterMs, MOST_START_MS));
					return;
				}
				const idle = ctx.isIdle?.() ?? true;
				pi.sendUserMessage(
					noTurnWords(spawned, turn, waited),
					idle ? undefined : { deliverAs: "followUp" },
				);
			},
			waited - (Date.now() - spawnedAt),
		);
		// A look still to come never keeps the process up.
		watch.unref?.();
		watches.add(watch);
	};
	lookAfter(afterMs);
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
	const trust = spawned.trustWaits
		? ` Nothing had trusted ${spawned.trustWaits} when it was spawned, so its pi was to stop at pi's folder-trust prompt there until someone answers it in its window.`
		: "";
	return automatedText(
		"a session this one spawned has not started",
		`${which} that this session spawned on ${spawned.questId} has not started its first turn ${seconds} s after the spawn: ${turn.found}.${trust} Find out why and get it working: look at its window and its record under ~/.local/state/pi/agentic-harness.pi/quest-workflow/sessions/, then tell it to carry on, or spawn it again if it never started.`,
	);
}
