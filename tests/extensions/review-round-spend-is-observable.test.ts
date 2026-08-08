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

import { describe, expect, it } from "vitest";
import { recordReviewerRun } from "../../extensions/review-integration/reviewer.js";
import type { RunRecord } from "../../lib/observability/index.js";
import { registerRunRecorder } from "../../lib/observability/index.js";
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

	it("says nothing when the runner priced nothing", () => {
		// Absent is not zero anywhere else in this round's accounting,
		// and a meter is the last place to invent a number: a run
		// recorded at zero is indistinguishable from a free one.
		const kept = recorded(() => {
			recordReviewerRun({
				runId: "council-1",
				participantId: "wren",
				startedAt: 1_700_000_000_000,
				result: ran({ usage: undefined }),
			});
		});

		expect(kept).toHaveLength(0);
	});
});
