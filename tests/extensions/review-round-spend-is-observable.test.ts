/**
 * What a round spends reaches the same places a fleet's spend does.
 *
 * A fleet publishes every settled subagent to the process-wide run
 * recorder, and the observability extension turns that into a footer
 * meter and an `observe_runs` row. A council published nothing, so the
 * most expensive tool in this harness was the one whose cost you
 * could not see while it ran, and `observe_runs` could not answer what
 * a round had cost afterwards.
 *
 * The recorder's own docstring already said it covered "both the fleet
 * dispatcher and the council runner". Only one half was ever wired.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecord } from "@jitsusama/agentic-harness.core/observability";
import { registerRunRecorder } from "@jitsusama/agentic-harness.core/observability";
import { describe, expect, it } from "vitest";
import { recordReviewerRun } from "../../extensions/review-integration/reviewer.js";
import type { RunReviewerResult } from "../../lib/subagent/index.js";

/** Whatever the recorder is handed while the body runs. */
function recorded(body: () => void): RunRecord[] {
	const kept: RunRecord[] = [];
	const stop = registerRunRecorder((record) => kept.push(record));
	try {
		body();
	} finally {
		stop();
	}
	return kept;
}

/** A reviewer that finished, priced the way the runner prices one. */
function ran(over: Partial<RunReviewerResult> = {}): RunReviewerResult {
	return {
		exitCode: 0,
		finalAssistantText: "{}",
		stderr: "",
		usage: {
			tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, total: 900 },
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3.5 },
		},
		...over,
	} as RunReviewerResult;
}

describe("what a round spends", () => {
	it("is published the way a fleet publishes a subagent", () => {
		const kept = recorded(() => {
			recordReviewerRun({
				runId: "council-20260808T000000000-000001",
				participantId: "hawk",
				model: "anthropic/claude-opus-5",
				startedAt: 1_700_000_000_000,
				result: ran(),
			});
		});

		expect(kept).toHaveLength(1);
		expect(kept[0]).toMatchObject({
			runId: "council-20260808T000000000-000001",
			subagentId: "hawk",
			// The kind is what tells a round from a fan-out in the run
			// table, and the recorder's docstring already named both.
			kind: "council",
			model: "anthropic/claude-opus-5",
		});
		expect(kept[0]?.cost.total).toBeCloseTo(3.5);
		expect(kept[0]?.tokens.total).toBe(900);
	});

	it("publishes a reviewer that died, since it was still billed", () => {
		// The same rule the round's own accounting follows: a reviewer
		// that spent its whole budget to produce nothing is the dearest
		// outcome there is, and a meter that leaves it out understates
		// exactly the round worth knowing about.
		const kept = recorded(() => {
			recordReviewerRun({
				runId: "council-1",
				participantId: "owl",
				startedAt: 1_700_000_000_000,
				result: ran({ exitCode: 1, finalAssistantText: "" }),
			});
		});

		expect(kept).toHaveLength(1);
		expect(kept[0]?.cost.total).toBeCloseTo(3.5);
	});

	it("publishes a run nothing priced, rather than losing it", () => {
		// Absent is not zero where a round says what it cost, because
		// there the number is the claim. Here the row is the claim, and
		// withholding it loses the run. The worst failure this repo has
		// recorded is a whole round killed before anybody could bill
		// anything, and that is the one event the run table would then
		// have had nothing at all to say about.
		const kept = recorded(() => {
			recordReviewerRun({
				runId: "council-1",
				participantId: "wren",
				startedAt: 1_700_000_000_000,
				result: ran({ usage: undefined }),
			});
		});

		expect(kept).toHaveLength(1);
		expect(kept[0]?.cost.total).toBe(0);
	});

	it("files each round kind under itself, not all under council", () => {
		// The field exists to tell them apart, and a constant made it
		// lie for four of the five. The kind is already written into
		// every round's id, so nothing needs plumbing to reach it.
		const kept = recorded(() => {
			for (const id of [
				"council-1",
				"judge-2",
				"critique-3",
				"audit-4",
				"stack-5",
			]) {
				recordReviewerRun({
					runId: id,
					participantId: "hawk",
					startedAt: 1,
					result: ran(),
				});
			}
		});

		expect(kept.map((record) => record.kind)).toEqual([
			"council",
			"judge",
			"critique",
			"audit",
			"stack",
		]);
	});

	it("keeps what the runner said about verification", () => {
		// Hand-projecting the result dropped this, which pins every
		// council row in the run table at "none" however it went.
		const kept = recorded(() => {
			recordReviewerRun({
				runId: "council-1",
				participantId: "hawk",
				startedAt: 1,
				result: ran({
					verification: { ok: true },
				} as Partial<RunReviewerResult>),
			});
		});

		expect(kept[0]?.verifyOutcome).toBe("passed");
	});

	it("is actually called by the round, not merely available to it", () => {
		// The cases above prove the helper and would all pass with the
		// one production call deleted, which is the shape of fault this
		// plan keeps rediscovering: the piece is tested and the join is
		// not. A scan is a poor test and the right one here, since the
		// closure it lives in is reachable only by running a round.
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"..",
				"..",
				"extensions",
				"review-integration",
				"tools",
				"ask.ts",
			),
			"utf8",
		);

		expect(source).toContain("recordReviewerRun({");
		// And that a retry bills the round it substitutes into rather
		// than the throwaway one it ran under, which is a run id the
		// ledger never names.
		expect(source).toContain("runId: billTo ?? context.runId");
		expect(source.split("charters, held.id)").length - 1).toBe(2);
	});
});
