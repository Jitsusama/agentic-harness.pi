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

/** Where one participant has got to. */
export type AskProgressState = "pending" | "running" | "answered" | "failed";

/** One participant's row, as a reporter would draw it. */
export interface AskProgressEntry {
	readonly participantId: string;
	readonly state: AskProgressState;
	/** What it is doing right now, or empty once it has settled. */
	readonly activity: string;
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
export function trackAskProgress(): {
	progress: AskProgress;
	entries(): AskProgressEntry[];
} {
	// A Map rather than an array: rows are looked up by id on every
	// event, and insertion order is the roster order a reporter draws
	// in, which Map preserves and an object does not promise.
	const rows = new Map<string, AskProgressEntry>();

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
						state: "pending",
						activity: "",
					});
				}
			},
			started(id) {
				amend(id, { state: "running" });
			},
			activity(id, what) {
				amend(id, { activity: what });
			},
			answered(id) {
				// Clearing the activity is the point: a settled row still
				// reading "reading app.ts" reads as though it still is.
				amend(id, { state: "answered", activity: "" });
			},
			failed(id, reason) {
				amend(id, { state: "failed", activity: "", reason });
			},
			recorded(id, findings) {
				amend(id, { findings });
			},
			finish() {},
		},
		entries: () => [...rows.values()],
	};
}
