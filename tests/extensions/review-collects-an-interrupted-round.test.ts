/**
 * A round nobody was there to finish can still be finished.
 *
 * The other half of writing a round down before it asks anybody. The
 * ledger entry says a council opened and never settled; this is the
 * part that turns the reviewer directories it points at back into
 * findings, without asking anybody or spending anything.
 *
 * Asserted through the adapter rather than through the tool, because
 * the seam that can silently rot is the one between what the
 * supervisor wrote to disk and what a round can read back. The
 * library's own rules are pinned in tests/lib/review/collect.test.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	answerLeftBehind,
	heldByLiveSupervisor,
} from "../../extensions/review-integration/reviewer.js";
import type { AskAnswer, AskRun, Finding } from "../../lib/review/index.js";
import { collectRound } from "../../lib/review/index.js";
import { ReviewerArtifactsStore } from "../../lib/subagent/index.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "collect-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const RUN = "council-20260806T120000000-000001";

/** One finding, in the shape a reviewer answers with. */
function said(subject: string): string {
	return JSON.stringify({
		findings: [
			{
				location: { kind: "file", file: "lib/a.ts" },
				label: "issue",
				subject,
				discussion: "because",
			},
		],
	});
}

/**
 * Write what the supervisor writes when a reviewer finishes.
 *
 * Deliberately the real file, at the real path, through the real path
 * builder. A fixture that invents its own layout would pass while the
 * two sides disagreed about where anything lives.
 */
function leaveBehind(
	store: ReviewerArtifactsStore,
	reviewerId: string,
	result: Record<string, unknown>,
): void {
	const paths = store.paths(RUN, reviewerId);
	mkdirSync(paths.reviewerDir, { recursive: true });
	writeFileSync(
		paths.resultPath,
		JSON.stringify({
			schemaVersion: 1,
			runId: RUN,
			reviewerId,
			state: "complete",
			exitCode: 0,
			...result,
		}),
		"utf8",
	);
}

/** The ledger entry a session leaves when it dies holding a round. */
function unsettled(over: Partial<AskRun> = {}): AskRun {
	return {
		id: RUN,
		round: "council",
		startedAt: "2026-08-06T12:00:00.000Z",
		participants: [
			{ id: "hawk", role: "reviewer" },
			{ id: "owl", role: "reviewer" },
		],
		outcomes: [],
		open: true,
		...over,
	};
}

/** Collect a round over a store, numbering findings as the real one does. */
async function collect(run: AskRun, store: ReviewerArtifactsStore) {
	const answers = new Map<string, AskAnswer>();
	for (const participant of run.participants) {
		const left = await answerLeftBehind(store, run.id, participant.id);
		if (left.kind === "answer") answers.set(participant.id, left.answer);
	}
	const kept: Finding[] = [];
	let issued = 0;
	const result = await collectRound(run, answers, {
		async record(findings) {
			const numbered = findings.map((finding) => ({
				...finding,
				id: ++issued,
			}));
			kept.push(...numbered);
			return numbered;
		},
	});
	return { ...result, kept };
}

describe("collecting a round the session did not live to finish", () => {
	it("turns what the reviewers left on disk back into findings", async () => {
		const store = new ReviewerArtifactsStore(root);
		leaveBehind(store, "hawk", { finalAssistantText: said("a") });
		leaveBehind(store, "owl", { finalAssistantText: said("b") });

		const { run, kept } = await collect(unsettled(), store);

		expect(kept.map((f) => f.subject)).toEqual(["a", "b"]);
		expect(run.outcomes.map((o) => o.findingIds)).toEqual([[1], [2]]);
		expect(run.open).toBeUndefined();
	});

	it("keeps what a reviewer wrote down when its answer never came", async () => {
		// The case the journal exists for, arriving by the other road:
		// the reviewer was stopped, so there is no answer to parse, and
		// the supervisor folded its journal into the result file.
		const store = new ReviewerArtifactsStore(root);
		leaveBehind(store, "hawk", {
			state: "timeout",
			exitCode: 143,
			finalAssistantText: "Let me look at the store next.",
			journal: [
				{
					location: { kind: "file", file: "lib/a.ts" },
					label: "issue",
					subject: "the lease is never released",
					discussion: "because",
				},
			],
		});
		leaveBehind(store, "owl", { finalAssistantText: said("b") });

		const { kept } = await collect(unsettled(), store);

		expect(kept.map((f) => f.subject)).toEqual([
			"the lease is never released",
			"b",
		]);
	});

	it("says which reviewers left nothing behind at all", async () => {
		const store = new ReviewerArtifactsStore(root);
		leaveBehind(store, "hawk", { finalAssistantText: said("a") });

		const { run } = await collect(unsettled(), store);

		const owl = run.outcomes.find((o) => o.participantId === "owl");
		expect(owl?.failure).toMatch(/nothing/i);
	});

	it("reads the wrap-up beside the stop, not the fragment alone", async () => {
		// A stopped reviewer's work spans up to three directories,
		// because the wrap-up is spawned under a suffixed id so it does
		// not overwrite the record of the stop. The live path folds them
		// in memory and never writes the merge back, so a reader of the
		// base directory alone keeps the fragment and discards the
		// answer.
		const store = new ReviewerArtifactsStore(root);
		leaveBehind(store, "hawk", {
			state: "timeout",
			exitCode: 143,
			finalAssistantText: "Now let me check the store.",
		});
		leaveBehind(store, "hawk+wrapup", {
			finalAssistantText: said("what it had when we stopped it"),
		});
		leaveBehind(store, "owl", { finalAssistantText: said("b") });

		const { kept } = await collect(unsettled(), store);

		expect(kept.map((f) => f.subject)).toEqual([
			"what it had when we stopped it",
			"b",
		]);
	});

	it("costs one participant when a result file cannot be read", async () => {
		// Not the whole collect. Six good reviewers must not be lost to
		// one bad file, and the round must not be left open with every
		// later attempt walking into the same directory.
		const store = new ReviewerArtifactsStore(root);
		const paths = store.paths(RUN, "hawk");
		mkdirSync(paths.reviewerDir, { recursive: true });
		writeFileSync(paths.resultPath, '{"finalAssistantText": "cut off he');
		leaveBehind(store, "owl", { finalAssistantText: said("b") });

		const { run, kept } = await collect(unsettled(), store);

		expect(kept.map((f) => f.subject)).toEqual(["b"]);
		expect(run.outcomes).toHaveLength(2);
	});

	it("refuses to read a file carrying neither an answer nor findings", async () => {
		// The dangerous shape: it parses, so filling in the blanks
		// yields a reviewer that read the change and had no complaint,
		// which then settles the round and hides the loss for good.
		const store = new ReviewerArtifactsStore(root);
		leaveBehind(store, "hawk", { note: "a shape this cannot read" });

		const left = await answerLeftBehind(store, RUN, "hawk");

		expect(left.kind).toBe("unreadable");
	});

	it("anchors against the witness the round was asked with", async () => {
		// A finding collected an hour later has to point where it would
		// have pointed live, and the witness is the only part of that
		// which is not in the reviewer's own answer.
		const store = new ReviewerArtifactsStore(root);
		leaveBehind(store, "hawk", { finalAssistantText: said("a") });

		const { kept } = await collect(unsettled({ witness: "abc1234" }), store);

		expect(kept[0]?.anchor.witness).toBe("abc1234");
	});
});

describe("heldByLiveSupervisor", () => {
	/** Write the lease the supervisor keeps renewing while it runs. */
	function lease(
		store: ReviewerArtifactsStore,
		reviewerId: string,
		fields: Record<string, unknown>,
	): void {
		const paths = store.paths(RUN, reviewerId);
		mkdirSync(paths.reviewerDir, { recursive: true });
		writeFileSync(paths.leasePath, JSON.stringify(fields), "utf8");
	}

	const NOW = Date.parse("2026-08-06T12:00:00.000Z");

	it("holds a round whose supervisor is beating", async () => {
		// Collecting under a live session files the findings of whoever
		// finished, then that session files them all again.
		const store = new ReviewerArtifactsStore(root);
		lease(store, "hawk", {
			supervisorPid: process.pid,
			updatedAt: new Date(NOW - 2_000).toISOString(),
		});

		expect(await heldByLiveSupervisor(store, RUN, ["hawk"], NOW)).toMatchObject(
			{ reviewerId: "hawk", pid: process.pid },
		);
	});

	it("releases a round whose lease stopped being renewed", async () => {
		// The case that made this a heartbeat rather than a pid check.
		// Nothing deletes a lease, so a finished supervisor leaves one
		// naming its pid; when the machine hands that number to anything
		// else, a pid check refuses the collect forever and waiting does
		// not help, because nothing will ever write the lease again.
		const store = new ReviewerArtifactsStore(root);
		lease(store, "hawk", {
			supervisorPid: process.pid,
			updatedAt: new Date(NOW - 10 * 60_000).toISOString(),
		});

		expect(
			await heldByLiveSupervisor(store, RUN, ["hawk"], NOW),
		).toBeUndefined();
	});

	it("releases a round whose supervisor said it had finished", async () => {
		const store = new ReviewerArtifactsStore(root);
		lease(store, "hawk", {
			supervisorPid: process.pid,
			updatedAt: new Date(NOW).toISOString(),
			completedAt: new Date(NOW).toISOString(),
		});

		expect(
			await heldByLiveSupervisor(store, RUN, ["hawk"], NOW),
		).toBeUndefined();
	});

	it("releases a round with no lease at all", async () => {
		const store = new ReviewerArtifactsStore(root);

		expect(
			await heldByLiveSupervisor(store, RUN, ["hawk"], NOW),
		).toBeUndefined();
	});
});
