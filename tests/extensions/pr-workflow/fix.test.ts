import { describe, expect, it } from "vitest";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import {
	getNextFix,
	recordFixDone,
	recordFixSkip,
	summarizeFixQueue,
} from "../../../extensions/pr-workflow/fix.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import { decideFinding } from "../../../extensions/pr-workflow/synthesis.js";
import { expectFailure, prMetadata } from "./fixtures.js";

function judgedFinding(id: number, subject: string): Finding {
	return {
		id,
		location: {
			kind: "line",
			file: "cache.ts",
			start: 12,
			end: 12,
			side: "new",
		},
		label: "issue",
		decorations: [],
		subject,
		discussion: "details",
		category: "scope",
		origin: { kind: "judge", runId: "j-1", judgeReviewerId: "j" },
		state: "draft",
		agreement: { raisedBy: ["fast"], sourceFindingIds: [] },
	};
}

function makeJudge(findings: Finding[]): JudgeRun {
	return {
		id: "j-1",
		startedAt: "2026-01-01T00:05:00Z",
		judgeReviewerId: "j",
		selfSignal: null,
		consolidatedFindings: findings,
		warnings: [],
	};
}

function stackFixState(homePrNumber = 102) {
	const state = createPrWorkflowState();
	state.pr = {
		reference: { owner: "o", repo: "r", number: 101 },
		loadedAt: "2026-01-01T00:00:00Z",
		metadata: null,
		files: null,
		stack: {
			cursorIndex: 0,
			cursorChildren: [],
			entries: [
				{
					reference: { owner: "o", repo: "r", number: 101 },
					title: "PR 101",
					baseRefName: "main",
					headRefName: "f101",
				},
				{
					reference: { owner: "o", repo: "r", number: 102 },
					title: "PR 102",
					baseRefName: "f101",
					headRefName: "f102",
				},
			],
		},
	};
	state.stackFindingRun = {
		id: "sc-1",
		startedAt: "2026-01-01T00:05:00Z",
		reviewerId: "sc",
		warnings: [],
		findings: [
			{
				id: 50,
				location: { kind: "global" },
				label: "issue",
				decorations: [],
				subject: "cross-PR concern",
				discussion: "d",
				category: "scope",
				origin: { kind: "cross-PR", runId: "sc-1", reviewerId: "sc" },
				state: "draft",
				homePrNumber,
				spans: [homePrNumber],
			},
		],
	};
	return state;
}

describe("getNextFix", () => {
	it("returns null when there is no judge run", () => {
		const state = createPrWorkflowState();
		expect(getNextFix(state)).toBeNull();
	});

	it("returns null when no decisions exist", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		expect(getNextFix(state)).toBeNull();
	});

	it("returns null when no fix-verdicted decisions exist", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "endorse" });
		expect(getNextFix(state)).toBeNull();
	});

	it("returns the first fix-verdicted finding in judge order", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([
			judgedFinding(1, "A"),
			judgedFinding(2, "B"),
			judgedFinding(3, "C"),
		]);
		decideFinding(state, { findingId: 2, verdict: "fix" });
		decideFinding(state, {
			findingId: 3,
			verdict: "fix",
			instructions: "rename foo",
		});

		const next = getNextFix(state);
		expect(next).not.toBeNull();
		expect(next?.findingId).toBe(2);
	});

	it("includes instructions when the decision had them", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, {
			findingId: 1,
			verdict: "fix",
			instructions: "rename cfg to config",
		});

		const next = getNextFix(state);
		expect(next?.instructions).toBe("rename cfg to config");
	});

	it("returns null instructions when none were provided", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });

		const next = getNextFix(state);
		expect(next?.instructions).toBeNull();
	});

	it("skips fixes that have been recorded as done", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([
			judgedFinding(1, "A"),
			judgedFinding(2, "B"),
		]);
		decideFinding(state, { findingId: 1, verdict: "fix" });
		decideFinding(state, { findingId: 2, verdict: "fix" });
		recordFixDone(state, 1, "abc1234");

		const next = getNextFix(state);
		expect(next?.findingId).toBe(2);
	});

	it("skips fixes that have been recorded as skipped", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([
			judgedFinding(1, "A"),
			judgedFinding(2, "B"),
		]);
		decideFinding(state, { findingId: 1, verdict: "fix" });
		decideFinding(state, { findingId: 2, verdict: "fix" });
		recordFixSkip(state, 1, "no longer relevant");

		const next = getNextFix(state);
		expect(next?.findingId).toBe(2);
	});

	it("returns null when every queued fix has an outcome", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });
		recordFixDone(state, 1, "abc1234");

		expect(getNextFix(state)).toBeNull();
	});

	it("queues a cross-PR stack fix targeting its home PR after per-PR fixes", () => {
		const state = stackFixState();
		decideFinding(state, { findingId: 50, verdict: "fix", scope: "stack" });

		const next = getNextFix(state);
		expect(next?.findingId).toBe(50);
		expect(next?.homePrNumber).toBe(102);
		expect(next?.target).toEqual({
			owner: "o",
			repo: "r",
			number: 102,
			branch: "f102",
		});
	});

	it("refuses a target when the cross-PR finding's home PR is not in the stack", () => {
		// Point the finding at a home PR that is not in the stack, and
		// give the cursor PR a real branch so a fallback to it would
		// produce a non-null (wrong) target rather than null by luck.
		const state = stackFixState(999);
		if (state.pr) {
			state.pr.metadata = prMetadata({ head: { ref: "f101", sha: "sha101" } });
		}
		decideFinding(state, { findingId: 50, verdict: "fix", scope: "stack" });

		const next = getNextFix(state);
		expect(next?.findingId).toBe(50);
		expect(next?.homePrNumber).toBe(999);
		// It must not fall back to the cursor PR (#101): committing a
		// cross-PR fix to the wrong branch is worse than refusing.
		expect(next?.target).toBeNull();
	});

	it("records a stack fix outcome against the stack decision map", () => {
		const state = stackFixState();
		decideFinding(state, { findingId: 50, verdict: "fix", scope: "stack" });

		expect(recordFixDone(state, 50, "deadbee").ok).toBe(true);
		const decision = state.stackDecisions.get(50);
		expect(decision?.verdict).toBe("fix");
		if (decision?.verdict === "fix") {
			expect(decision.resolvedBy?.commitSha).toBe("deadbee");
		}
		expect(getNextFix(state)).toBeNull();
	});
});

describe("recordFixDone", () => {
	it("trims and stores the commit sha plus a timestamp", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });

		const result = recordFixDone(
			state,
			1,
			"  abc1234  ",
			() => new Date("2026-05-19T12:00:00Z"),
		);

		expect(result).toEqual({ ok: true });
		const decision = state.council.decisions.get(1);
		expect(decision?.verdict).toBe("fix");
		if (decision?.verdict !== "fix") throw new Error("verdict drift");
		expect(decision.resolvedBy?.commitSha).toBe("abc1234");
		expect(decision.resolvedBy?.recordedAt).toBe("2026-05-19T12:00:00.000Z");
	});

	it("preserves the original instructions", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, {
			findingId: 1,
			verdict: "fix",
			instructions: "rename cfg",
		});

		recordFixDone(state, 1, "abc1234");

		const decision = state.council.decisions.get(1);
		if (decision?.verdict !== "fix") throw new Error("verdict drift");
		expect(decision.instructions).toBe("rename cfg");
	});

	it("rejects empty commit shas", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });

		expectFailure(recordFixDone(state, 1, "   "));
	});

	it("rejects unknown finding ids", () => {
		const state = createPrWorkflowState();
		expectFailure(recordFixDone(state, 99, "abc1234"));
	});

	it("rejects decisions that aren't queued for fix", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "endorse" });

		const result = recordFixDone(state, 1, "abc1234");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error).toMatch(/not queued for fix/);
	});

	it("rejects decisions that already have a commit recorded", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });
		recordFixDone(state, 1, "abc1234");

		const result = recordFixDone(state, 1, "def5678");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error).toMatch(/already recorded as fixed/);
	});

	it("rejects decisions that were already skipped", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });
		recordFixSkip(state, 1, "abandoned");

		const result = recordFixDone(state, 1, "abc1234");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error).toMatch(/already recorded as skipped/);
	});
});

describe("recordFixSkip", () => {
	it("trims and stores the reason plus a timestamp", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });

		const result = recordFixSkip(
			state,
			1,
			"  no longer relevant  ",
			() => new Date("2026-05-19T12:00:00Z"),
		);

		expect(result).toEqual({ ok: true });
		const decision = state.council.decisions.get(1);
		if (decision?.verdict !== "fix") throw new Error("verdict drift");
		expect(decision.skipped?.reason).toBe("no longer relevant");
		expect(decision.skipped?.recordedAt).toBe("2026-05-19T12:00:00.000Z");
	});

	it("rejects empty reasons", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });

		expectFailure(recordFixSkip(state, 1, "   "));
	});

	it("rejects decisions that already have an outcome", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });
		recordFixDone(state, 1, "abc1234");

		const result = recordFixSkip(state, 1, "actually fine");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error).toMatch(/already recorded as fixed/);
	});
});

describe("summarizeFixQueue", () => {
	it("counts zero for an empty state", () => {
		const state = createPrWorkflowState();
		expect(summarizeFixQueue(state)).toEqual({
			pending: 0,
			committed: 0,
			skipped: 0,
		});
	});

	it("only counts fix-verdicted decisions", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([
			judgedFinding(1, "A"),
			judgedFinding(2, "B"),
			judgedFinding(3, "C"),
		]);
		decideFinding(state, { findingId: 1, verdict: "endorse" });
		decideFinding(state, { findingId: 2, verdict: "fix" });
		decideFinding(state, { findingId: 3, verdict: "dismiss" });

		expect(summarizeFixQueue(state)).toEqual({
			pending: 1,
			committed: 0,
			skipped: 0,
		});
	});

	it("buckets by outcome status", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([
			judgedFinding(1, "A"),
			judgedFinding(2, "B"),
			judgedFinding(3, "C"),
			judgedFinding(4, "D"),
		]);
		decideFinding(state, { findingId: 1, verdict: "fix" });
		decideFinding(state, { findingId: 2, verdict: "fix" });
		decideFinding(state, { findingId: 3, verdict: "fix" });
		decideFinding(state, { findingId: 4, verdict: "fix" });
		recordFixDone(state, 1, "abc1234");
		recordFixDone(state, 2, "def5678");
		recordFixSkip(state, 3, "abandoned");
		// 4 stays pending

		expect(summarizeFixQueue(state)).toEqual({
			pending: 1,
			committed: 2,
			skipped: 1,
		});
	});
});
