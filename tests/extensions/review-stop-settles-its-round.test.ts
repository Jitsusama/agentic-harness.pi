/**
 * Stopping a round settles it, rather than leaving it open for a
 * collect nobody makes.
 *
 * On 30 October five of the ten rounds open on the machine had been
 * stopped and never collected: stop asked the reviewers to go and said
 * "collect it once they are gone", or refused to close a round a
 * reviewer had left something in. Each one then nagged every session
 * at its start.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	runArtifactDir,
	runDir,
} from "../../extensions/review-integration/engine.ts";
import {
	collectOne,
	stopRound,
} from "../../extensions/review-integration/tools/ask.ts";
import {
	type AskRun,
	type ChangeRef,
	createRunStore,
} from "../../lib/core/review/index.ts";
import { ReviewerArtifactsStore } from "../../lib/subagent/index.ts";

const change: ChangeRef = {
	provider: "github",
	repo: { key: "github:o/stopped" },
	id: "3",
	label: "o/stopped#3",
};

/** A council written down before anybody answered, never settled. */
function opened(id: string): AskRun {
	return {
		id,
		round: "council",
		startedAt: new Date().toISOString(),
		participants: [{ id: "hawk", role: "reviewer" }],
		outcomes: [],
		open: true,
	};
}

/**
 * A reviewer whose supervisor said it finished, having left a result
 * when `answered`.
 */
function gone(runId: string, answered: boolean): void {
	const paths = new ReviewerArtifactsStore(runArtifactDir()).paths(
		runId,
		"hawk",
	);
	mkdirSync(paths.reviewerDir, { recursive: true });
	const at = new Date().toISOString();
	writeFileSync(
		paths.leasePath,
		JSON.stringify({
			supervisorPid: 1,
			supervisorStartedAt: Date.now() - 60_000,
			updatedAt: at,
			completedAt: at,
		}),
		"utf8",
	);
	if (!answered) return;
	writeFileSync(
		paths.resultPath,
		JSON.stringify({
			schemaVersion: 1,
			runId,
			reviewerId: "hawk",
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

describe("stopping a round", () => {
	it("collects what its reviewers left, so it is no longer open", async () => {
		const run = "council-20261030T224403000-000001";
		const store = createRunStore(runDir());
		await store.keep(change, opened(run));
		gone(run, true);

		const answer = await stopRound(change, { run });

		expect(
			answer.content[0]?.type === "text" && answer.content[0].text,
		).toContain(`Collected ${run}`);
		const held = await store.byId(change, run);
		expect(held?.open).toBeUndefined();
		expect(held?.outcomes.map((one) => one.findingIds?.length)).toEqual([1]);
	});

	it("says a change holds no rounds, not that they settled, when none are held", async () => {
		// What a reference resolved through another provider than the one
		// that ran its rounds finds: on 30 October a World change named as
		// shop/world#2337887 read an empty ledger and answered "Every round
		// settled on its own" while three sat open under delta.
		const nowhere: ChangeRef = { ...change, id: "5", label: "o/stopped#5" };

		const answer = await collectOne(nowhere, {});
		const text =
			answer.content[0]?.type === "text" ? answer.content[0].text : "";

		expect(text).toContain("No rounds are held against o/stopped#5");
		expect(text).toContain("github");
		expect(text).not.toContain("settled on its own");
	});

	it("closes one that left nothing, rather than leaving it open", async () => {
		const other: ChangeRef = { ...change, id: "4", label: "o/stopped#4" };
		const run = "council-20261030T224404000-000001";
		const store = createRunStore(runDir());
		await store.keep(other, opened(run));
		gone(run, false);

		await stopRound(other, { run });

		const held = await store.byId(other, run);
		expect(held?.open).toBeUndefined();
		expect(held?.closed).toBe(true);
	});
});
