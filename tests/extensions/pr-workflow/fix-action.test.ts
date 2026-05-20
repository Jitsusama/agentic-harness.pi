import { describe, expect, it } from "vitest";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import {
	formatFixQueueStatus,
	nextFixAction,
	recordFixDoneAction,
	recordFixSkipAction,
} from "../../../extensions/pr-workflow/fix-action.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import {
	createPrWorkflowState,
	type PrWorkflowState,
} from "../../../extensions/pr-workflow/state.js";
import { decideFinding } from "../../../extensions/pr-workflow/synthesis.js";
import { expectFailure, prMetadata } from "./fixtures.js";

function loadPr(state: PrWorkflowState): void {
	state.pr = {
		reference: { owner: "o", repo: "r", number: 42 },
		loadedAt: "2026-01-01T00:00:00Z",
		metadata: null,
		files: null,
		stack: null,
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

function judgedFinding(
	id: number,
	subject: string,
	overrides?: Partial<Finding>,
): Finding {
	return {
		id,
		location: {
			kind: "line",
			file: "cache.ts",
			start: 12,
			end: 14,
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
		...overrides,
	};
}

describe("nextFixAction", () => {
	it("fails when no PR is loaded", async () => {
		const state = createPrWorkflowState();
		expectFailure(await nextFixAction(state));
	});

	it("fails when no judge run has happened", async () => {
		const state = createPrWorkflowState();
		loadPr(state);
		expectFailure(await nextFixAction(state));
	});

	it("returns a null context and a 'no fixes' summary when the queue is empty", async () => {
		const state = createPrWorkflowState();
		loadPr(state);
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);

		const result = await nextFixAction(state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.context).toBeNull();
		expect(result.summary).toMatch(/no fixes queued/i);
	});

	it("returns a 'queue done' summary when every fix has an outcome", async () => {
		const state = createPrWorkflowState();
		loadPr(state);
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });
		recordFixDoneAction({ state, findingId: 1, commitSha: "abc1234" });

		const result = await nextFixAction(state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.context).toBeNull();
		expect(result.summary).toMatch(/queue done/i);
		expect(result.summary).toMatch(/1 committed/);
	});

	it("returns the next fix with subject, location, and counts", async () => {
		const state = createPrWorkflowState();
		loadPr(state);
		state.council.lastJudge = makeJudge([
			judgedFinding(1, "Null deref"),
			judgedFinding(2, "Variable shadowing"),
		]);
		decideFinding(state, {
			findingId: 1,
			verdict: "fix",
			instructions: "guard the null branch",
		});
		decideFinding(state, { findingId: 2, verdict: "fix" });

		const result = await nextFixAction(state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.context?.findingId).toBe(1);
		expect(result.summary).toContain("Null deref");
		expect(result.summary).toContain("cache.ts:12-14");
		expect(result.summary).toContain("guard the null branch");
		expect(result.summary).toMatch(/2 pending/);
	});

	it("omits the instructions line when none were given", async () => {
		const state = createPrWorkflowState();
		loadPr(state);
		state.council.lastJudge = makeJudge([judgedFinding(1, "Null deref")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });

		const result = await nextFixAction(state);
		if (!result.ok) throw new Error("expected ok");
		expect(result.summary).not.toContain("Instructions:");
	});

	it("renders file locations without line numbers when kind is 'file'", async () => {
		const state = createPrWorkflowState();
		loadPr(state);
		state.council.lastJudge = makeJudge([
			judgedFinding(1, "Module-wide concern", {
				location: { kind: "file", file: "app.ts" },
			}),
		]);
		decideFinding(state, { findingId: 1, verdict: "fix" });

		const result = await nextFixAction(state);
		if (!result.ok) throw new Error("expected ok");
		expect(result.summary).toContain("Location: app.ts");
		expect(result.summary).not.toContain("app.ts:");
	});
});

describe("nextFixAction worktree provisioning", () => {
	function loadPrWithMetadata(state: PrWorkflowState): void {
		state.pr = {
			reference: { owner: "o", repo: "r", number: 42 },
			loadedAt: "2026-01-01T00:00:00Z",
			metadata: prMetadata({
				head: { ref: "pr/widget", sha: "deadbeef" },
			}),
			files: null,
			stack: null,
		};
	}

	it("surfaces the worktree path in summary and result when provisioning succeeds", async () => {
		const state = createPrWorkflowState();
		loadPrWithMetadata(state);
		state.council.lastJudge = makeJudge([judgedFinding(1, "Null deref")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });

		const provision = async (req: {
			owner: string;
			repo: string;
			number: number;
			branch: string;
		}) => ({
			path: `/state/fix-worktrees/${req.owner}-${req.repo}-${req.number}`,
			branch: req.branch,
		});

		const result = await nextFixAction(state, provision);
		if (!result.ok) throw new Error("expected ok");
		expect(result.worktree).toEqual({
			path: "/state/fix-worktrees/o-r-42",
			branch: "pr/widget",
		});
		expect(result.summary).toContain("/state/fix-worktrees/o-r-42");
		expect(result.summary).toMatch(/Worktree:/);
	});

	it("surfaces a warning in the summary when provisioning fails, without erroring", async () => {
		const state = createPrWorkflowState();
		loadPrWithMetadata(state);
		state.council.lastJudge = makeJudge([judgedFinding(1, "Null deref")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });

		const provision = async () => {
			throw new Error("git fetch failed: branch not on remote");
		};

		const result = await nextFixAction(state, provision);
		if (!result.ok) throw new Error("expected ok");
		expect(result.worktree).toBeNull();
		expect(result.summary).toContain("branch not on remote");
		expect(result.summary).toMatch(/Worktree provisioning failed/i);
	});

	it("omits worktree fields when no PR metadata is loaded", async () => {
		const state = createPrWorkflowState();
		loadPr(state); // metadata: null
		state.council.lastJudge = makeJudge([judgedFinding(1, "Null deref")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });

		const provision = async () => {
			throw new Error("should not be called");
		};

		const result = await nextFixAction(state, provision);
		if (!result.ok) throw new Error("expected ok");
		expect(result.worktree).toBeNull();
		expect(result.summary).not.toMatch(/Worktree/i);
	});

	it("does not call provision when the queue is empty", async () => {
		const state = createPrWorkflowState();
		loadPrWithMetadata(state);
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		// no decideFinding: queue empty

		let called = false;
		const provision = async () => {
			called = true;
			throw new Error("should not be called");
		};

		const result = await nextFixAction(state, provision);
		if (!result.ok) throw new Error("expected ok");
		expect(called).toBe(false);
		expect(result.worktree).toBeNull();
	});
});

describe("recordFixDoneAction", () => {
	it("delegates to recordFixDone and propagates ok", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });

		const result = recordFixDoneAction({
			state,
			findingId: 1,
			commitSha: "abc1234",
		});
		expect(result).toEqual({ ok: true });
	});

	it("propagates the underlying failure unchanged", () => {
		const state = createPrWorkflowState();
		const result = recordFixDoneAction({
			state,
			findingId: 1,
			commitSha: "abc1234",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error).toMatch(/no decision for finding 1/);
	});
});

describe("recordFixSkipAction", () => {
	it("delegates to recordFixSkip and propagates ok", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix" });

		const result = recordFixSkipAction({
			state,
			findingId: 1,
			reason: "not relevant",
		});
		expect(result).toEqual({ ok: true });
	});

	it("propagates the underlying failure unchanged", () => {
		const state = createPrWorkflowState();
		const result = recordFixSkipAction({
			state,
			findingId: 99,
			reason: "n/a",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error).toMatch(/no decision for finding 99/);
	});
});

describe("formatFixQueueStatus", () => {
	it("reports an empty queue with no findings", () => {
		const state = createPrWorkflowState();
		expect(formatFixQueueStatus(state)).toBe("fix queue: empty");
	});

	it("reports pending / committed / skipped counts", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([
			judgedFinding(1, "A"),
			judgedFinding(2, "B"),
			judgedFinding(3, "C"),
		]);
		decideFinding(state, { findingId: 1, verdict: "fix" });
		decideFinding(state, { findingId: 2, verdict: "fix" });
		decideFinding(state, { findingId: 3, verdict: "fix" });
		recordFixDoneAction({ state, findingId: 1, commitSha: "abc" });
		recordFixSkipAction({ state, findingId: 2, reason: "n/a" });

		expect(formatFixQueueStatus(state)).toBe(
			"fix queue: 1 pending, 1 committed, 1 skipped",
		);
	});
});
