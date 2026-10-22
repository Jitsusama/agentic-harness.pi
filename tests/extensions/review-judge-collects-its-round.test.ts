/**
 * A judge collects a finished round itself rather than refusing.
 *
 * Asked to judge a change whose council had been started and not
 * collected, the judge refused with "collect it first" eleven times in
 * a week, and every time the agent's next call was the collect.
 * Collecting asks nobody and spends nothing, so the judge does it, and
 * leaves a round that is still running alone.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import {
	type AskRun,
	type ChangeRef,
	createRunStore,
} from "@jitsusama/agentic-harness.core/review";
import { describe, expect, it } from "vitest";
import {
	runArtifactDir,
	runDir,
} from "../../extensions/review-integration/engine.ts";
import { collectFinished } from "../../extensions/review-integration/tools/ask.ts";
import { ReviewerArtifactsStore } from "../../lib/subagent/index.ts";

const change: ChangeRef = {
	provider: "github",
	repo: { key: "github:o/judged" },
	id: "9",
	label: "o/judged#9",
};

const RUN = "council-20261022T010000000-000001";

/** A council written down before anybody answered, never settled. */
const open: AskRun = {
	id: RUN,
	round: "council",
	startedAt: "2026-10-22T01:00:00.000Z",
	participants: [{ id: "hawk", role: "reviewer" }],
	outcomes: [],
	open: true,
};

/** What the supervisor writes when a reviewer finishes. */
function finished(reviewerId: string): void {
	const paths = new ReviewerArtifactsStore(runArtifactDir()).paths(
		RUN,
		reviewerId,
	);
	mkdirSync(paths.reviewerDir, { recursive: true });
	writeFileSync(
		paths.resultPath,
		JSON.stringify({
			schemaVersion: 1,
			runId: RUN,
			reviewerId,
			state: "complete",
			exitCode: 0,
			finalAssistantText: JSON.stringify({
				findings: [
					{
						location: { kind: "file", file: "lib/a.ts" },
						label: "issue",
						subject: "the handle leaks",
						discussion: "because",
					},
				],
			}),
		}),
		"utf8",
	);
}

describe("a judge meeting a council nobody collected", () => {
	it("collects a finished round, so the latest council is there to judge", async () => {
		const store = createRunStore(runDir());
		await store.keep(change, open);
		finished("hawk");
		expect(await store.latest(change, "council")).toBeUndefined();

		// Ten minutes on, since a reviewer directory younger than the
		// start window reads as a supervisor still starting.
		const collected = await collectFinished(change, Date.now() + 600_000);

		expect(collected.running).toEqual([]);
		expect(collected.said.join("\n")).toContain(`Collected ${RUN}`);
		const council = await store.latest(change, "council");
		expect(council?.id).toBe(RUN);
		expect(council?.open).toBeUndefined();
	});

	it("leaves a round that is still starting alone, and names it", async () => {
		const other: ChangeRef = { ...change, id: "11", label: "o/judged#11" };
		const store = createRunStore(runDir());
		await store.keep(other, open);
		finished("hawk");

		const collected = await collectFinished(other);

		expect(collected.said).toEqual([]);
		expect(collected.running.join(" ")).toContain("still starting");
		expect(await store.latest(other, "council")).toBeUndefined();
	});

	it("leaves settled rounds alone", async () => {
		const other: ChangeRef = { ...change, id: "10", label: "o/judged#10" };
		const store = createRunStore(runDir());
		const settled: AskRun = { ...open, id: `${RUN}-settled` };
		delete (settled as { open?: true }).open;
		await store.keep(other, settled);

		expect(await collectFinished(other)).toEqual({ said: [], running: [] });
	});
});
