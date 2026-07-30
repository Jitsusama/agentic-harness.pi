import { describe, expect, it } from "vitest";
import {
	QUEUE_QUERY,
	queueStateFrom,
} from "../../../lib/review/providers/github/queue.js";

/** The envelope GraphQL wraps every answer in. */
function answer(pullRequest: unknown): unknown {
	return { data: { repository: { pullRequest } } };
}

describe("queueStateFrom", () => {
	it("reads unqueued from the shape a live API actually returned", () => {
		// Copied from a real `gh api graphql` run against an open pull
		// request in a repo with no merge queue configured.
		const state = queueStateFrom(
			answer({
				autoMergeRequest: null,
				isInMergeQueue: false,
				mergeQueueEntry: null,
				mergeStateStatus: "UNKNOWN",
			}),
		);

		expect(state).toEqual({ posture: "unqueued" });
	});

	it("reads an unwrapped answer as unqueued rather than guessing", () => {
		// Worth pinning, because the first version of this reader skipped the
		// `data` envelope and the unqueued test above passed anyway: unqueued
		// is also what a shape it cannot read falls back to. A reader that
		// accepted both shapes would hide exactly that drift.
		expect(
			queueStateFrom({
				repository: { pullRequest: { mergeQueueEntry: { state: "QUEUED" } } },
			}).posture,
		).toBe("unqueued");
	});

	it("survives an answer with nothing in it", () => {
		// A repo the token cannot see returns nulls all the way down, and
		// a provider that threw there would break reading over authoring.
		expect(queueStateFrom({}).posture).toBe("unqueued");
		expect(queueStateFrom(null).posture).toBe("unqueued");
	});

	it("reports queued when an entry holds a place", () => {
		const state = queueStateFrom(
			answer({
				mergeQueueEntry: { state: "QUEUED", position: 4, solo: false },
			}),
		);

		expect(state.posture).toBe("queued");
		expect(state.position).toBe(4);
		expect(state.solo).toBe(false);
	});

	it("reports waiting while the queue is still running checks", () => {
		// GitHub's own distinction, and the one that decides which of the
		// two hazards the caller is being warned about.
		const state = queueStateFrom(
			answer({ mergeQueueEntry: { state: "AWAITING_CHECKS", solo: true } }),
		);

		expect(state.posture).toBe("waiting");
	});

	it("treats every other entry state as holding a place", () => {
		for (const state of ["QUEUED", "MERGEABLE", "LOCKED", "UNMERGEABLE"]) {
			expect(
				queueStateFrom(answer({ mergeQueueEntry: { state } })).posture,
				`${state} should hold a place in the queue`,
			).toBe("queued");
		}
	});

	it("carries the entry state through so a refusal can quote it", () => {
		const state = queueStateFrom(
			answer({ mergeQueueEntry: { state: "UNMERGEABLE" } }),
		);

		expect(state.detail).toContain("UNMERGEABLE");
	});

	it("reads auto-merge as waiting rather than queued", () => {
		// Nothing is batched behind an auto-merge request, so ejecting it
		// costs only this change. Calling it `queued` would overstate it.
		const state = queueStateFrom(
			answer({
				autoMergeRequest: { enabledAt: "2026-07-30T00:00:00Z" },
				mergeQueueEntry: null,
			}),
		);

		expect(state.posture).toBe("waiting");
		expect(state.solo).toBe(true);
	});

	it("prefers a queue entry over an auto-merge request", () => {
		// Both can be true at once, and the entry is the authoritative and
		// more expensive fact.
		const state = queueStateFrom(
			answer({
				autoMergeRequest: { enabledAt: "2026-07-30T00:00:00Z" },
				mergeQueueEntry: { state: "QUEUED", solo: false },
			}),
		);

		expect(state.posture).toBe("queued");
		expect(state.solo).toBe(false);
	});

	it("asks for exactly the fields it reads", () => {
		// A query that drifts from the reader returns nulls rather than an
		// error, so the queue would silently read as unqueued.
		for (const field of [
			"mergeQueueEntry",
			"state",
			"position",
			"solo",
			"autoMergeRequest",
			"enabledAt",
		]) {
			expect(QUEUE_QUERY, `${field} must be in the query`).toContain(field);
		}
	});
});
