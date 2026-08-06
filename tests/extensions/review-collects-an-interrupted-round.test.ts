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
import { answerLeftBehind } from "../../extensions/review-integration/reviewer.js";
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
		const answer = await answerLeftBehind(store, run.id, participant.id);
		if (answer !== undefined) answers.set(participant.id, answer);
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
