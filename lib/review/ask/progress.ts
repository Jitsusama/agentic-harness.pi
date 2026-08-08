/**
 * What an ask round is doing while it does it.
 *
 * A council fans its roster out concurrently, which means the useful
 * minutes of a round are minutes in which nothing is returned. A
 * caller with no way to watch cannot tell a roster that is working
 * from one that has hung, and the difference matters most when it is
 * six subprocesses deep.
 *
 * The library emits events and holds no view. It also cannot see a
 * subprocess: activity arrives because whoever implements `ask`
 * reports it, which is what keeps this side free of any knowledge of
 * streams, terminals or pi's wire format.
 */

import type { Participant } from "./identity.js";

/**
 * Where one participant has got to.
 *
 * Five, because a reviewer somebody stopped is not a reviewer that
 * answered. With four states a cancelled one kept the mark and the
 * colour of success, so the panel said the round had gone well at the
 * exact moment somebody was telling it otherwise.
 */
export type AskProgressState =
	| "pending"
	| "running"
	| "answered"
	| "cancelled"
	| "failed";

/** One participant's row, as a reporter would draw it. */
export interface AskProgressEntry {
	readonly participantId: string;
	/**
	 * Which model is answering, when the participant named one.
	 *
	 * Carried for the panel to show, because on a roster of seven personas
	 * the model is what tells you whether the slow one is slow for a
	 * reason. It is on the participant already; a reporter that dropped it
	 * would have to be handed the roster a second time to draw a row.
	 */
	readonly model?: string;
	readonly state: AskProgressState;
	/** What it is doing right now, or empty once it has settled. */
	readonly activity: string;
	/**
	 * When it was sent away, in epoch milliseconds.
	 *
	 * A round is silent for a long time and the honest question a
	 * watcher has is how long this one has been going. Recorded on
	 * the row rather than computed by whoever draws, so every
	 * surface answers it the same way and a row that has settled
	 * still says how long it took.
	 */
	readonly startedAtMs?: number;
	/** When it settled, however it settled. */
	readonly settledAtMs?: number;
	/** Findings recorded from it, once they have been numbered. */
	readonly findings?: number;
	/** Why it failed, when it did. */
	readonly reason?: string;
}

/**
 * Told what is happening, in the order it happens.
 *
 * Every method returns nothing and must not throw: a reporter that
 * fails should never take a round down with it.
 */
export interface AskProgress {
	/** The whole roster, before anything runs, so a reporter can size itself. */
	start(participants: readonly Participant[]): void;
	/** This participant is away. */
	started(participantId: string): void;
	/** What it is doing right now. */
	activity(participantId: string, what: string): void;
	/** It answered. Its findings have not been counted yet. */
	answered(participantId: string): void;
	/** It failed, and why. */
	failed(participantId: string, reason: string): void;
	/**
	 * Somebody stopped it.
	 *
	 * Separate from failing, because it is the one settled state that is
	 * not news about the change. It outranks a later answer: the runner
	 * can report a reviewer home after the kill reached the panel, and
	 * repainting that row green loses the only thing the watcher knew.
	 */
	cancelled(participantId: string): void;
	/** Its findings have landed and been numbered. */
	recorded(participantId: string, findings: number): void;
	/** The round is over. */
	finish(): void;
}

/**
 * Record and report each reply in turn, in roster order.
 *
 * Both rounds settle their replies the same way and differ only in how
 * a reply is filed, so the reporting lives here rather than in each.
 * That is not tidiness: the stack round already shipped without it,
 * because the reporting was two lines a caller had to remember, and
 * the round that reports nothing is the longest one there is.
 *
 * Sequential and in roster order deliberately, which is what makes
 * finding numbers deterministic. Recording concurrently would hand out
 * ids in completion order.
 */
export async function settleReplies<Reply, Outcome>(
	replies: readonly Reply[],
	file: (reply: Reply) => Promise<Outcome>,
	count: (outcome: Outcome) => { participantId: string; findings: number },
	progress: AskProgress | undefined,
): Promise<Outcome[]> {
	const outcomes: Outcome[] = [];
	for (const reply of replies) {
		const outcome = await file(reply);
		outcomes.push(outcome);
		// The count comes from filing rather than from the answer: a
		// finding that would not parse never became one.
		const { participantId, findings } = count(outcome);
		progress?.recorded(participantId, findings);
	}
	progress?.finish();
	return outcomes;
}

/** An observer that does nothing, for a caller that does not care. */
export const noAskProgress: AskProgress = {
	start() {},
	started() {},
	activity() {},
	answered() {},
	failed() {},
	cancelled() {},
	recorded() {},
	finish() {},
};

/**
 * An observer that folds what it is told into rows.
 *
 * Every reporter needs this same fold, so it lives here rather than
 * being written again per surface. `entries` is a snapshot: read it
 * whenever you want to draw.
 */
export function trackAskProgress(
	// Injected so a test can hold time still. Defaults to the wall
	// clock, since every real caller wants exactly that and making
	// them all say so would be ceremony.
	now: () => number = Date.now,
): {
	progress: AskProgress;
	entries(): AskProgressEntry[];
} {
	// A Map rather than an array: rows are looked up by id on every
	// event, and insertion order is the roster order a reporter draws
	// in, which Map preserves and an object does not promise.
	const rows = new Map<string, AskProgressEntry>();

	/**
	 * Whether somebody already stopped this one.
	 *
	 * Cancelling outranks whatever the runner says next, in both
	 * directions. Killing a subprocess is not instant, so a reviewer can
	 * report home after the kill has reached the panel, and it is likelier
	 * to report a failure than an answer: a killed process exits non-zero.
	 * Guarding only the answer left the likelier of the two paths
	 * repainting the row red, so the panel blamed the round for something
	 * a person did on purpose.
	 */
	const stopped = (id: string): boolean => rows.get(id)?.state === "cancelled";

	/** Change one row, if we have heard of it. */
	const amend = (id: string, change: Partial<AskProgressEntry>): void => {
		const row = rows.get(id);
		// A late event from a round that was cancelled must not invent a
		// participant nobody asked for.
		if (row === undefined) return;
		rows.set(id, { ...row, ...change });
	};

	return {
		progress: {
			start(participants) {
				rows.clear();
				for (const one of participants) {
					rows.set(one.id, {
						participantId: one.id,
						...(one.model === undefined ? {} : { model: one.model }),
						state: "pending",
						activity: "",
					});
				}
			},
			started(id) {
				amend(id, { state: "running", startedAtMs: now() });
			},
			activity(id, what) {
				amend(id, { activity: what });
			},
			answered(id) {
				// Clearing the activity is the point: a settled row still
				// reading "reading app.ts" reads as though it still is.
				if (stopped(id)) return;
				amend(id, { state: "answered", activity: "", settledAtMs: now() });
			},
			cancelled(id) {
				amend(id, { state: "cancelled", activity: "", settledAtMs: now() });
			},
			failed(id, reason) {
				// The likelier of the two late reports after a kill, since a
				// killed process exits non-zero.
				if (stopped(id)) return;
				amend(id, {
					state: "failed",
					activity: "",
					reason,
					settledAtMs: now(),
				});
			},
			recorded(id, findings) {
				amend(id, { findings });
			},
			finish() {},
		},
		entries: () => [...rows.values()],
	};
}
