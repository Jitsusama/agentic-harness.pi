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
	findingDir,
	runArtifactDir,
	runDir,
} from "../../../../extensions/review-integration/engine.ts";
import {
	settledHere,
	settlingHere,
} from "../../../../extensions/review-integration/settling.ts";
import {
	collectOne,
	stopRound,
} from "../../../../extensions/review-integration/tools/ask-settle.ts";
import {
	type AskRun,
	type ChangeRef,
	createFindingStore,
	createRunStore,
} from "../../../../lib/core/review/index.ts";
import { ReviewerArtifactsStore } from "../../../../lib/subagent/index.ts";

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

	// PV3TE0's second round on #2007: a stop waits out a round this
	// process is settling, and once the old load has filed it, a collect
	// from the copy read before the wait would file it all again.
	it("files nothing again when the round settled while it waited", async () => {
		const settled: ChangeRef = { ...change, id: "6", label: "o/stopped#6" };
		const run = "council-20261030T224405000-000001";
		const store = createRunStore(runDir());
		const findings = createFindingStore(findingDir());
		await store.keep(settled, opened(run));
		gone(run, true);
		const oldLoad = {};
		settlingHere(run, oldLoad);

		const stopping = stopRound(settled, { run });
		// Long enough for the stop to be polling, well inside its 15 s:
		// the old load then files the round and its call answers.
		await new Promise((done) => setTimeout(done, 600));
		const [filed] = await findings.record(settled, [
			{
				anchor: { subject: "file", path: "lib/a.ts" },
				label: "issue",
				origin: { kind: "reviewer", runId: run, reviewerId: "hawk" },
				subject: "the handle leaks",
				discussion: "because",
			},
		]);
		const { open: _open, ...rest } = opened(run);
		await store.keep(settled, {
			...rest,
			outcomes: [
				{
					participantId: "hawk",
					findingIds: filed === undefined ? [] : [filed.id],
				},
			],
		});
		settledHere(oldLoad);
		const answer = await stopping;

		expect(
			answer.content[0]?.type === "text" ? answer.content[0].text : "",
			"says it settled, not that it collected",
		).toContain("settled on its own");
		expect(
			(await findings.list(settled)).length,
			"each finding filed once",
		).toBe(1);
		expect(
			(await store.byId(settled, run))?.outcomes,
			"the old load's ledger kept",
		).toEqual([{ participantId: "hawk", findingIds: [filed?.id] }]);
	});

	// PV3TE0's third round on #2007: a round whose reviewers all failed
	// leaves nothing behind, and closing the copy read before the wait
	// would write over the failures the old load filed.
	it("keeps what the old load filed when a round that left nothing settled while it waited", async () => {
		const failed: ChangeRef = { ...change, id: "7", label: "o/stopped#7" };
		const run = "council-20261030T224406000-000001";
		const store = createRunStore(runDir());
		await store.keep(failed, opened(run));
		gone(run, false);
		const oldLoad = {};
		settlingHere(run, oldLoad);

		const stopping = stopRound(failed, { run });
		// Long enough for the stop to be polling, well inside its 15 s.
		await new Promise((done) => setTimeout(done, 600));
		const { open: _open, ...rest } = opened(run);
		const outcomes: AskRun["outcomes"] = [
			{ participantId: "hawk", findingIds: [], failure: "no provider" },
		];
		await store.keep(failed, { ...rest, outcomes });
		settledHere(oldLoad);
		const answer = await stopping;

		expect(
			answer.content[0]?.type === "text" ? answer.content[0].text : "",
			"says it settled, not that it closed it",
		).toContain("settled on its own");
		const held = await store.byId(failed, run);
		expect(held?.outcomes, "the old load's failures kept").toEqual(outcomes);
		expect(held?.closed, "not closed by the stop").toBeUndefined();
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
		expect(held).toMatchObject({ closed: true });
	});
});
