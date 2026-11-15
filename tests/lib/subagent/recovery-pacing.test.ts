/**
 * The look for orphaned reviewers shares the thread as it walks.
 *
 * It walks every run kept, 436 runs and 737 reviewers on one wake on
 * 15 November, and on that wake it took 1.3 s of the main thread in
 * the seconds a session was starting. So it gives the thread back once
 * a stretch has run its slice, and what it finds is the same either
 * way.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.ts";
import {
	type Pace,
	type ReaperDeps,
	recoverReviewerRuns,
} from "../../../lib/subagent/recovery.ts";

/** A machine on which every supervisor is gone and nothing is killed. */
const nobodyThere: ReaperDeps = {
	alive: () => false,
	startedAt: async () => undefined,
	kill: () => undefined,
	wait: async () => undefined,
};

/** A store of finished reviewers and orphaned ones, a few of each. */
async function keptRuns(): Promise<ReviewerArtifactsStore> {
	const store = new ReviewerArtifactsStore(
		await mkdtemp(join(tmpdir(), "pr-pacing-")),
	);
	for (let run = 0; run < 6; run++) {
		const paths = await store.ensureReviewerDir(`run-${run}`, "one");
		if (run % 2 === 0) {
			await store.writeJsonAtomic(paths.resultPath, {
				state: "complete",
				exitCode: 0,
				finalAssistantText: "done",
			});
			continue;
		}
		await store.writeJsonAtomic(paths.progressPath, {
			state: "running",
			activity: "thinking",
			updatedAt: "2026-01-01T00:00:00Z",
		});
		await store.writeJsonAtomic(paths.leasePath, {
			state: "running",
			supervisorPid: 999_999,
			updatedAt: "2026-01-01T00:00:00Z",
		});
	}
	return store;
}

/**
 * A pace whose clock moves `stepMs` each time it is read, counting how
 * often the thread is given back.
 */
function slowClock(stepMs: number): Pace & { readonly givenBack: number } {
	let now = 0;
	let givenBack = 0;
	return {
		now: () => {
			now += stepMs;
			return now;
		},
		giveBack: async () => {
			givenBack++;
		},
		get givenBack() {
			return givenBack;
		},
	};
}

describe("the look for orphaned reviewers", () => {
	it("gives the thread back once a stretch has run past its slice", async () => {
		const pace = slowClock(30);

		await recoverReviewerRuns(await keptRuns(), nobodyThere, pace);

		expect(
			pace.givenBack,
			"times the walk gave the thread back over six reviewers at 30 ms each",
		).toBeGreaterThanOrEqual(5);
	});

	it("keeps the thread while a stretch is inside its slice", async () => {
		const pace = slowClock(0);

		await recoverReviewerRuns(await keptRuns(), nobodyThere, pace);

		expect(pace.givenBack, "times a walk with no time passing gave way").toBe(
			0,
		);
	});

	it("finds what an unpaced walk finds", async () => {
		const paced = await recoverReviewerRuns(
			await keptRuns(),
			nobodyThere,
			slowClock(30),
		);
		const unpaced = await recoverReviewerRuns(
			await keptRuns(),
			nobodyThere,
			slowClock(0),
		);

		const named = (found: readonly { runId: string }[]) =>
			found.map((one) => one.runId).sort();
		expect(named(paced.completed)).toEqual(named(unpaced.completed));
		expect(named(paced.stale)).toEqual(named(unpaced.stale));
		expect(named(paced.stale)).toEqual(["run-1", "run-3", "run-5"]);
	});
});
