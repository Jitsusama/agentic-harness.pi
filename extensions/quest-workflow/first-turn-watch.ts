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
 *
 * A session whose pi ended without taking its words is reopened once,
 * from this session, by the terminal the spawn would have opened had
 * the launcher not taken it ({@link offerReopen}). From 04:27 on 11-10
 * every session the shell started died at once with "Failed to get LLM
 * token": its holder ran pi without dev's bin folder on PATH, so
 * Shopify's pi wrapper couldn't fetch its key, while a window opened
 * from a running session inherits one. Only telling left five sessions
 * unstarted until somebody acted on it.
 *
 * A session the launcher took is opened in its own time, one window
 * after another, so no pi of it running a minute on says nothing of
 * whether it died: at 13:28 on 10 November the launcher opened RCTRF8's
 * window past the minute, and the look had already opened it again
 * from here, so RCTRF8 ran as two sessions (Y2YBTS [9f93dcd0]). So one
 * the launcher took is opened again only once a pi of it was seen
 * running and has gone without taking its words. Until one is seen,
 * it is looked for each minute up to MOST_START_MS, and then its
 * spawner is told.
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
	/** Whether the desktop's launcher took it, to open when it gets to it. */
	readonly handed?: boolean;
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
 * Opens a spawned session again from this session, answering what it
 * opened, as the words the spawner is told.
 */
export type Reopen = () => Promise<string>;

/** How each spawn still watched can be opened again, by its words' key. */
const reopeners = new Map<string, Reopen>();

/**
 * Say how to open the session spawned under `key` again, should its pi
 * end without taking its words: once, and only while it is watched.
 */
export function offerReopen(key: string, reopen: Reopen): void {
	reopeners.set(key, reopen);
}

/** The way to open a spawn again, taken so it is tried only once. */
function takeReopen(key: string): Reopen | undefined {
	const reopen = reopeners.get(key);
	reopeners.delete(key);
	return reopen;
}

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
		...(details?.how === "launcher" ? { handed: true } : {}),
	};
}

/**
 * Look, after `afterMs`, for the first turn of the session `spawned`
 * started, and when there is none start a turn here saying which
 * session, on which quest, and what the records show. While its words
 * still wait and its pi runs, look again each `afterMs` instead, up to
 * MOST_START_MS, unless the spawn said its pi waits at the folder-trust
 * prompt: a pi waiting there runs and still hasn't taken its words, and
 * will wait as long as nobody answers. When its words wait and no pi of
 * it runs, it is opened again once, if the spawn offered a way, and
 * watched afresh; only a failed reopen, or a second session that doesn't
 * start, starts a turn here. One the launcher took is opened again only
 * once a pi of it was seen running, and is otherwise looked for again
 * up to MOST_START_MS, since the launcher may not have got to it yet.
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
	// Whether a pi of it has run at any look, which for one the launcher
	// took is what says it was opened at all.
	let seenRunning = false;
	const lookAfter = (waited: number) => {
		const watch = setTimeout(
			() => {
				watches.delete(watch);
				const turn = look(spawned, spawnedAt);
				if (turn.started) {
					reopeners.delete(spawned.key);
					return;
				}
				const piRuns = turn.waiting === true && runs(spawned);
				seenRunning ||= piRuns;
				const notYetOpened = spawned.handed === true && !seenRunning;
				const stillToCome =
					(piRuns && !spawned.trustWaits) || (notYetOpened && turn.waiting);
				if (stillToCome && waited < MOST_START_MS) {
					lookAfter(Math.min(waited + afterMs, MOST_START_MS));
					return;
				}
				const reopen =
					turn.waiting && !piRuns && !notYetOpened
						? takeReopen(spawned.key)
						: undefined;
				reopeners.delete(spawned.key);
				if (reopen) {
					reopenAndWatch(pi, ctx, spawned, turn, waited, reopen, {
						look,
						afterMs,
						runs,
					});
					return;
				}
				const unopened = notYetOpened
					? "The desktop's launcher took it, but no pi of it has run since, so it wasn't opened again from here, which would make it two sessions once the launcher opens it."
					: undefined;
				tell(pi, ctx, noTurnWords(spawned, turn, waited, unopened));
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
	reopeners.clear();
}

/**
 * Start a turn here saying what the spawner has to act on. A run under
 * way hears it once its tool calls finish: as a follow-up it waited for
 * the whole run, and on 10 November a warning raised at 06:54 reached
 * its spawner at 08:18.
 */
function tell(pi: ExtensionAPI, ctx: ExtensionContext, words: string): void {
	const idle = ctx.isIdle?.() ?? true;
	pi.sendUserMessage(words, idle ? undefined : { deliverAs: "steer" });
}

/** The local clock time now, as HH:MM. */
function clockNow(): string {
	return new Date().toTimeString().slice(0, CLOCK_CHARS);
}

/** How much of `toTimeString` is the hours and minutes. */
const CLOCK_CHARS = 5;

/**
 * Open a spawn whose pi ended again, say so without starting a turn, and
 * watch the session it opens as a spawn of its own, which has no second
 * reopen. A reopen that fails is told as a session that never started.
 */
function reopenAndWatch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	spawned: Spawned,
	turn: Extract<FirstTurn, { started: false }>,
	waited: number,
	reopen: Reopen,
	watching: {
		readonly look: LookForFirstTurn;
		readonly afterMs: number;
		readonly runs: PiRuns;
	},
): void {
	const session = turn.sessionId ?? spawned.sessionId;
	const which = session ? `Session ${session}` : "The session";
	reopen().then(
		(opened) => {
			pi.sendMessage({
				customType: "quest-spawn-reopened",
				content: automatedText(
					"a session this one spawned was opened again",
					`${which} that this session spawned on ${spawned.questId} ended without taking its first words within ${Math.round(waited / 1000)} s, and no pi of it runs. It was opened again from this session: ${opened}. Its first words still wait for it, and it is watched again.`,
				),
				display: true,
			});
			// The reopened pi starts under an id of its own, so only its
			// words' key finds it.
			watchFirstTurn(
				pi,
				ctx,
				{
					key: spawned.key,
					questId: spawned.questId,
					...(spawned.trustWaits ? { trustWaits: spawned.trustWaits } : {}),
				},
				watching.look,
				watching.afterMs,
				watching.runs,
			);
		},
		(error: unknown) => {
			const why = error instanceof Error ? error.message : String(error);
			tell(
				pi,
				ctx,
				noTurnWords(
					spawned,
					turn,
					waited,
					`Opening it again from here failed: ${why}.`,
				),
			);
		},
	);
}

/** What the spawner is told when its session took no first turn. */
function noTurnWords(
	spawned: Spawned,
	turn: Extract<FirstTurn, { started: false }>,
	afterMs: number,
	also?: string,
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
		`${which} that this session spawned on ${spawned.questId} has not started its first turn ${seconds} s after the spawn, when looked at ${clockNow()}: ${turn.found}.${trust}${also ? ` ${also}` : ""} Find out why and get it working: look at its window and its record under ~/.local/state/pi/agentic-harness.pi/quest-workflow/sessions/, then tell it to carry on, or spawn it again if it never started.`,
	);
}
