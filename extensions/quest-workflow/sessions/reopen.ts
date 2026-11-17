/**
 * Reopening lost sessions: through the launcher, the desktop's
 * sessions kitty or a terminal of their own, then waiting for each to
 * say it is running again before it counts as back.
 */

import {
	type HandedPlace,
	type HandedSession,
	launcherTakes,
} from "../../../lib/internal/quest/reopening/hand-over.ts";
import {
	SESSION_MARK,
	type Settled,
} from "../../../lib/internal/quest/reopening/reopen-in-place.ts";
import {
	openInSessionsKitty,
	sessionsKittyRuns,
} from "../../../lib/internal/quest/reopening/sessions-kitty.ts";
import {
	reopenCommand,
	type SessionRecord,
	startedAgain,
} from "../../../lib/internal/quest/sessions/session-registry.ts";
import { attachWords } from "../../../lib/internal/session/host-holds.ts";
import {
	describePlan,
	type OpenOptions,
	openTerminals,
	type TerminalLayout,
	type WindowPlace,
} from "../../../lib/terminal/index.ts";
import { count } from "../../../lib/ui/count.ts";
import { forgetRecord, loadRecords, readRecord } from "./records.ts";
import { savedSessions } from "./restore.ts";

/** What happened when restore tried to reopen the lost sessions. */
export interface ReopenOutcome {
	/** Sessions seen running again: their record is back in the open set. */
	reopened: string[];
	/**
	 * Sessions pi never saved, so a fresh pi was started on their quest
	 * in their place, and seen running. Counted among those reopened.
	 */
	fresh: { sessionId: string; quest?: string }[];
	/** Sessions whose terminal opened but which had not checked in yet. */
	unconfirmed: string[];
	failed: { sessionId: string; reason: string }[];
	/** Sessions held parked, woken in their own holder and window. */
	woken: string[];
	/** Sessions a holder was found running, so nothing was opened. */
	running: string[];
	/** Sessions a host holds, so nothing was opened: how to reach each. */
	hosted: { sessionId: string; host: string; attach: string[] }[];
	/** The line saying what the terminals were opened through. */
	used?: string;
	/** What the person should know, once each. */
	notes: string[];
	/** On a dry run, what would have been done, and nothing was. */
	planned?: boolean;
}

/**
 * How long restore waits for reopened sessions to say they are
 * running. A pi starts in a few seconds, and a dozen starting at once
 * on a loaded machine take longer, so the wait is generous; it is the
 * difference between reporting a session back and reporting a command
 * sent.
 */
export const REOPEN_CONFIRM_MS = 30_000;

/**
 * How long after one session's terminal is begun the next may be. At
 * 17:50 on 30 October six were reopened four at once, and every pi
 * starting together is the load Joel had said he'd rather wait out:
 * "about a second or two between each individual launch".
 */
export const REOPEN_PACE_MS = 2_000;

/** How often the records are read while waiting. */
const REOPEN_POLL_MS = 250;

/**
 * Reopen lost sessions, one terminal surface each, and report which
 * came back.
 *
 * The terminal library runs each resume line under the person's own
 * startup files: typed into a login shell where the terminal can be
 * typed into, through `$SHELL -l -i -c` where it cannot. Handed to a
 * terminal directly the line would run without them, which skips what
 * puts the right pi on PATH; that is what made the first manual
 * recovery take an hour. Tabs with no window to hold them are gathered
 * into one new window.
 *
 * A session counts as reopened only once its pi has started and put
 * its record back in the open set. One whose terminal opened but which
 * has not checked in by the end of the wait is reported as such, so a
 * command sent is never reported as a session restored.
 *
 * A session pi never saved has nothing to resume, so a fresh pi is
 * started on its quest instead (see `reopenCommand`). It counts as
 * back once a session in its place is running, and its record is then
 * forgotten, since the new session carries everything it held.
 *
 * Given `handOver`, the saved sessions go first to the desktop's
 * launcher, which reopens them one at a time, each back where it sat
 * (hand-over.ts). What it doesn't take, or every one when it doesn't
 * answer, is opened here as above, and so is every one pi never saved.
 */
export async function reopenLostSessions(
	records: readonly SessionRecord[],
	options: OpenOptions & {
		readonly layout?: TerminalLayout;
		readonly confirmMs?: number;
		/** How long between beginning one terminal and the next. */
		readonly paceMs?: number;
		readonly saved?: (sessionId: string) => boolean;
		/** Hands sessions to the launcher, answering how many it took. */
		readonly handOver?: (
			sessions: readonly HandedSession[],
		) => Promise<number | undefined>;
		/**
		 * Settles each session first: one a holder runs is left, one held
		 * parked is woken there, and the windows a dead one left are closed
		 * (reopen-in-place.ts).
		 */
		readonly settle?: (sessions: readonly string[]) => Promise<Settled>;
		/** Where each session's window goes under niri. */
		readonly placeOf?: (record: SessionRecord) => WindowPlace | undefined;
		/** The orchestrator, workspace and title each window is placed by. */
		readonly handedPlaceOf?: (record: SessionRecord) => HandedPlace;
	} = {},
): Promise<ReopenOutcome> {
	const {
		layout,
		confirmMs = REOPEN_CONFIRM_MS,
		paceMs = REOPEN_PACE_MS,
		saved = savedSessions(),
		handOver,
		settle,
		placeOf,
		handedPlaceOf = () => ({}),
		...open
	} = options;
	const outcome: ReopenOutcome = {
		reopened: [],
		fresh: [],
		unconfirmed: [],
		failed: [],
		woken: [],
		running: [],
		hosted: [],
		notes: [],
	};
	const settled =
		settle && !open.dryRun
			? await settle(records.map((record) => record.sessionId))
			: undefined;
	if (settled) {
		for (const { session, hold } of settled.hosted) {
			outcome.hosted.push({
				sessionId: session,
				host: hold.key,
				attach: attachWords(hold, session),
			});
		}
		outcome.woken.push(...settled.woken);
		outcome.running.push(...settled.running);
		for (const sessionId of settled.parked) {
			outcome.failed.push({
				sessionId,
				reason:
					"it is held parked, and its holder can't be woken from here; a key in its window wakes it",
			});
		}
		if (settled.closed > 0) {
			outcome.notes.push(
				`closed ${count(settled.closed, "window")} a dead session had left with no pi in it`,
			);
		}
	}
	const toOpen = settled
		? records.filter((record) => settled.reopen.includes(record.sessionId))
		: records;
	const handed =
		handOver && !open.dryRun
			? await handedToLauncher(toOpen, saved, handOver, handedPlaceOf)
			: [];
	const opened: SessionRecord[] = [...handed];
	const left = toOpen.filter((record) => !handed.includes(record));
	// Those the launcher would have opened but didn't take go where it
	// opens its own, the desktop's sessions kitty (sessions-kitty.ts).
	const inSessionsKitty =
		handOver && !open.dryRun && sessionsKittyRuns() ? left : [];
	for (const record of inSessionsKitty) {
		try {
			await openInSessionsKitty({
				cwd: record.cwd,
				...reopenCommand(record, saved(record.sessionId)),
			});
			opened.push(record);
		} catch (error) {
			outcome.failed.push({
				sessionId: record.sessionId,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (inSessionsKitty.length > 0) outcome.used ??= SESSIONS_KITTY_USED;
	const here = left.filter((record) => !inSessionsKitty.includes(record));
	const outcomes = await openTerminals(
		here.map((record) => {
			const window = placeOf?.(record);
			return {
				...(layout ? { layout } : {}),
				cwd: record.cwd,
				...reopenCommand(record, saved(record.sessionId)),
				// Its window closes with its pi, and says whose it was.
				endsWithCommand: true,
				marks: { [SESSION_MARK]: record.sessionId },
				...(window ? { window } : {}),
			};
		}),
		{ ...open, paceMs },
	);
	outcomes.forEach((result, index) => {
		const record = here[index];
		if (!record) return;
		if (!result.ok) {
			outcome.failed.push({
				sessionId: record.sessionId,
				reason: result.error,
			});
			return;
		}
		outcome.used ??= describePlan(result.plan);
		for (const note of result.notes) {
			if (!outcome.notes.includes(note)) outcome.notes.push(note);
		}
		if (result.how === "planned") outcome.planned = true;
		else if (result.how === "printed") {
			outcome.failed.push({
				sessionId: record.sessionId,
				reason: "no terminal could be opened",
			});
		} else opened.push(record);
	});
	if (handed.length > 0) {
		outcome.used = outcome.used
			? `${LAUNCHER_USED}, and ${outcome.used}`
			: LAUNCHER_USED;
	}
	if (outcome.planned) return outcome;
	// The launcher waits for each window before the next, so each it took
	// adds its pace to the wait.
	const back = await awaitCheckIn(
		opened,
		saved,
		confirmMs + handed.length * paceMs,
	);
	for (const record of opened) {
		const id = record.sessionId;
		if (!back.has(id)) outcome.unconfirmed.push(id);
		else if (saved(id)) outcome.reopened.push(id);
		else {
			forgetRecord(id);
			outcome.fresh.push({
				sessionId: id,
				...(record.quest ? { quest: record.quest } : {}),
			});
		}
	}
	return outcome;
}

/** How restore says it opened the sessions the launcher took. */
const LAUNCHER_USED = "the launcher, each where it sat";

/** How the sessions opened in the desktop's sessions kitty are said. */
const SESSIONS_KITTY_USED = "the desktop's sessions kitty";

/**
 * The records the launcher took: the saved ones it accepts, all or
 * none, since its answer says how many but never which. A partial
 * answer can't happen for sessions that pass its check, so one is read
 * as taking them all and any it dropped are reported unconfirmed.
 */
async function handedToLauncher(
	records: readonly SessionRecord[],
	saved: (sessionId: string) => boolean,
	handOver: (sessions: readonly HandedSession[]) => Promise<number | undefined>,
	placeOf: (record: SessionRecord) => HandedPlace,
): Promise<SessionRecord[]> {
	const going = records.filter(
		(record) =>
			saved(record.sessionId) &&
			launcherTakes({ id: record.sessionId, cwd: record.cwd }),
	);
	if (going.length === 0) return [];
	const taken = await handOver(
		going.map((record) => ({
			id: record.sessionId,
			cwd: record.cwd,
			...(record.quest ? { quest: record.quest } : {}),
			...(record.env ? { env: record.env } : {}),
			...placeOf(record),
			// Back where its own window was.
			replaces: record.sessionId,
		})),
	);
	return taken === undefined ? [] : going;
}

/**
 * Wait until each session is running again, or the wait runs out, and
 * return the ones that are. A resumed pi puts its own record back in
 * the open set as it starts; a fresh one started in a lost one's place
 * opens a record of its own on that quest, in that folder.
 */
async function awaitCheckIn(
	records: readonly SessionRecord[],
	saved: (sessionId: string) => boolean,
	waitMs: number,
): Promise<Set<string>> {
	const back = new Set<string>();
	const deadline = Date.now() + waitMs;
	while (back.size < records.length) {
		const fresh = records.some(
			(record) => !back.has(record.sessionId) && !saved(record.sessionId),
		);
		const all = fresh ? loadRecords().map((entry) => entry.record) : [];
		for (const record of records) {
			const id = record.sessionId;
			if (back.has(id)) continue;
			if (saved(id)) {
				const now = readRecord(id);
				if (now && now.closedAt === undefined) back.add(id);
			} else if (startedAgain(record, all, { running: true })) back.add(id);
		}
		if (back.size === records.length || Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, REOPEN_POLL_MS));
	}
	return back;
}
