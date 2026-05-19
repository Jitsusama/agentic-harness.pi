import { describe, expect, it, vi } from "vitest";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import {
	buildReviewPayload,
	type PostReviewExec,
	postReviewAction,
} from "../../../extensions/pr-workflow/post.js";
import type {
	StackCriticRun,
	StackFinding,
} from "../../../extensions/pr-workflow/stack-critic.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import { expectFailure, prMetadata } from "./fixtures.js";

function stackFinding(
	id: number,
	subject: string,
	homePrNumber: number,
	spans: number[],
): StackFinding {
	return {
		id,
		location: { kind: "global" },
		label: "issue",
		decorations: [],
		subject,
		discussion: `discussion for ${subject}`,
		category: "scope",
		origin: { kind: "stack-critic", runId: "sc-1", reviewerId: "sc" },
		state: "draft",
		homePrNumber,
		spans,
	};
}

function stackCriticRun(findings: StackFinding[]): StackCriticRun {
	return {
		id: "sc-1",
		startedAt: "x",
		reviewerId: "sc",
		findings,
		warnings: [],
	};
}

/**
 * Post gate.
 *
 * Translates the round-4 user verdicts into a real
 * GitHub review. Two layers:
 *
 *   - `buildReviewPayload(state)` (pure) — selects
 *     which findings post, renders bodies in
 *     Conventional Comments format, splits into
 *     inline comments vs body summary.
 *   - `postReviewAction({ state, event, body?, exec })`
 *     — refuses bad state, calls the injected exec
 *     boundary, marks findings as posted.
 */

function lineFinding(
	id: number,
	subject: string,
	overrides: Partial<Finding> = {},
): Finding {
	return {
		id,
		location: {
			kind: "line",
			file: "lib/x.ts",
			start: 10,
			end: 12,
			side: "new",
		},
		label: "issue",
		decorations: [],
		subject,
		discussion: `discussion for ${subject}`,
		category: "file",
		origin: { kind: "judge", runId: "j-1", judgeReviewerId: "j" },
		state: "draft",
		agreement: { raisedBy: ["fast", "skeptic"], sourceFindingIds: [1, 2] },
		...overrides,
	};
}

function fileFinding(id: number, subject: string): Finding {
	return {
		id,
		location: { kind: "file", file: "README.md" },
		label: "suggestion",
		decorations: [],
		subject,
		discussion: `discussion for ${subject}`,
		category: "file",
		origin: { kind: "judge", runId: "j-1", judgeReviewerId: "j" },
		state: "draft",
	};
}

function globalFinding(id: number, subject: string): Finding {
	return {
		id,
		location: { kind: "global" },
		label: "thought",
		decorations: [],
		subject,
		discussion: `discussion for ${subject}`,
		category: "scope",
		origin: { kind: "judge", runId: "j-1", judgeReviewerId: "j" },
		state: "draft",
	};
}

function judge(findings: Finding[]): JudgeRun {
	return {
		id: "j-1",
		startedAt: "2026-01-01T00:05:00Z",
		judgeReviewerId: "j",
		selfSignal: { confidence: "high", rationale: "ok" },
		consolidatedFindings: findings,
		warnings: [],
	};
}

describe("buildReviewPayload", () => {
	it("includes findings with endorse, qualify, edit, or promote verdicts", async () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([
			lineFinding(10, "Null deref"),
			lineFinding(11, "Logic gap"),
			lineFinding(12, "Typo"),
			lineFinding(13, "Style nit"),
		]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "endorse",
			decidedAt: "x",
		});
		state.council.decisions.set(11, {
			findingId: 11,
			verdict: "qualify",
			note: "soften to suggestion",
			decidedAt: "x",
		});
		state.council.decisions.set(12, {
			findingId: 12,
			verdict: "edit",
			subject: "Override subject",
			decidedAt: "x",
		});
		state.council.decisions.set(13, {
			findingId: 13,
			verdict: "promote",
			decidedAt: "x",
		});
		const payload = buildReviewPayload(state);
		expect(payload.comments).toHaveLength(4);
		expect(payload.includedFindingIds.sort()).toEqual([10, 11, 12, 13]);
	});

	it("excludes findings with dismiss verdict", async () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([
			lineFinding(10, "Keep me"),
			lineFinding(11, "Drop me"),
		]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "endorse",
			decidedAt: "x",
		});
		state.council.decisions.set(11, {
			findingId: 11,
			verdict: "dismiss",
			reason: "false positive",
			decidedAt: "x",
		});
		const payload = buildReviewPayload(state);
		expect(payload.includedFindingIds).toEqual([10]);
		expect(payload.skipped.find((s) => s.findingId === 11)?.reason).toMatch(
			/dismiss/i,
		);
	});

	it("excludes pending findings and explains why in `skipped`", async () => {
		// Pending findings need an explicit decision
		// before posting; the user shouldn't ship a
		// finding they haven't reviewed.
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([
			lineFinding(10, "Decided"),
			lineFinding(11, "Not yet"),
		]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "endorse",
			decidedAt: "x",
		});
		const payload = buildReviewPayload(state);
		expect(payload.includedFindingIds).toEqual([10]);
		expect(payload.skipped.find((s) => s.findingId === 11)?.reason).toMatch(
			/pending|decision/i,
		);
	});

	it("renders comment bodies in Conventional Comments format with label + subject + discussion", async () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([lineFinding(10, "Null deref")]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "endorse",
			decidedAt: "x",
		});
		const payload = buildReviewPayload(state);
		const body = payload.comments[0].body;
		// Conventional Comments: "**label:** subject"
		expect(body).toMatch(/\*\*issue:\*\*\s+Null deref/);
		// Discussion follows on a new line
		expect(body).toContain("discussion for Null deref");
	});

	it("applies edit overrides to the posted body, not the original", async () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([lineFinding(10, "Original")]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "edit",
			subject: "Override",
			discussion: "Override discussion",
			decidedAt: "x",
		});
		const payload = buildReviewPayload(state);
		const body = payload.comments[0].body;
		expect(body).toContain("Override");
		expect(body).toContain("Override discussion");
		expect(body).not.toContain("Original");
		expect(body).not.toContain("discussion for Original");
	});

	it("includes the qualify note inline so the reviewer can see how the finding was softened", async () => {
		// Distinguishes "I think this might be an issue"
		// from "this IS an issue". The note carries the
		// distinction.
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([lineFinding(10, "Maybe a bug")]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "qualify",
			note: "non-blocking, worth a follow-up",
			decidedAt: "x",
		});
		const payload = buildReviewPayload(state);
		const body = payload.comments[0].body;
		expect(body).toContain("non-blocking, worth a follow-up");
	});

	it("routes file and global findings into the body summary, not inline comments", async () => {
		// GitHub's pull-review API only attaches inline
		// comments to specific lines; file- and scope-
		// level findings have nowhere to land. Put them
		// in the review body summary instead.
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([
			lineFinding(10, "On a line"),
			fileFinding(11, "File-wide"),
			globalFinding(12, "About the PR overall"),
		]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "endorse",
			decidedAt: "x",
		});
		state.council.decisions.set(11, {
			findingId: 11,
			verdict: "endorse",
			decidedAt: "x",
		});
		state.council.decisions.set(12, {
			findingId: 12,
			verdict: "endorse",
			decidedAt: "x",
		});
		const payload = buildReviewPayload(state);
		expect(payload.comments).toHaveLength(1);
		expect(payload.comments[0].path).toBe("lib/x.ts");
		expect(payload.body).toContain("File-wide");
		expect(payload.body).toContain("About the PR overall");
	});

	it("translates side and start/end correctly for multi-line inline comments", async () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([
			lineFinding(10, "Block", {
				location: {
					kind: "line",
					file: "a.ts",
					start: 5,
					end: 10,
					side: "old",
				},
			}),
		]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "endorse",
			decidedAt: "x",
		});
		const payload = buildReviewPayload(state);
		expect(payload.comments[0]).toMatchObject({
			path: "a.ts",
			line: 10,
			startLine: 5,
			side: "LEFT",
		});
	});

	it("attributes findings by raisedBy in the comment body so reviewers see the model agreement", async () => {
		// Honest provenance: a finding two models agreed
		// on should look different from a single-model
		// suggestion.
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([
			lineFinding(10, "Strong signal", {
				agreement: { raisedBy: ["fast", "skeptic"], sourceFindingIds: [] },
			}),
		]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "endorse",
			decidedAt: "x",
		});
		const payload = buildReviewPayload(state);
		expect(payload.comments[0].body).toContain("fast");
		expect(payload.comments[0].body).toContain("skeptic");
	});
});

describe("postReviewAction", () => {
	function withJudgeAndDecision() {
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 42 },
			loadedAt: "x",
			metadata: prMetadata({
				title: "t",
				url: "u",
				author: "a",
				base: { ref: "main", sha: "deadbeef" },
				head: { ref: "feat", sha: "headsha1" },
			}),
			files: [],
			stack: null,
		};
		state.council.lastJudge = judge([lineFinding(10, "Null deref")]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "endorse",
			decidedAt: "x",
		});
		return state;
	}

	it("calls the exec boundary with the ref, event, body and comments", async () => {
		const state = withJudgeAndDecision();
		const exec: PostReviewExec = vi.fn(async () => undefined);
		const result = await postReviewAction({
			state,
			event: "COMMENT",
			exec,
		});
		expect(result.ok).toBe(true);
		expect(exec).toHaveBeenCalledTimes(1);
		const call = (exec as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.ref).toEqual({ owner: "o", repo: "r", number: 42 });
		expect(call.event).toBe("COMMENT");
		expect(call.comments).toHaveLength(1);
	});

	it("refuses to post when no PR is loaded", async () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([lineFinding(10, "x")]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "endorse",
			decidedAt: "x",
		});
		const exec: PostReviewExec = vi.fn();
		const result = await postReviewAction({
			state,
			event: "COMMENT",
			exec,
		});
		expect(result.ok).toBe(false);
		expect(exec).not.toHaveBeenCalled();
	});

	it("refuses to post when no findings are eligible — empty reviews are spam", async () => {
		const state = withJudgeAndDecision();
		state.council.decisions.clear();
		const exec: PostReviewExec = vi.fn();
		const result = await postReviewAction({ state, event: "COMMENT", exec });
		expect(expectFailure(result).error).toMatch(/no findings|empty|nothing/i);
		expect(exec).not.toHaveBeenCalled();
	});

	it("rejects unknown event values", async () => {
		const state = withJudgeAndDecision();
		const exec: PostReviewExec = vi.fn();
		const result = await postReviewAction({
			state,
			event: "BIKESHED" as never,
			exec,
		});
		expect(result.ok).toBe(false);
		expect(exec).not.toHaveBeenCalled();
	});

	it("uses the caller's custom body prefix when supplied, otherwise generates a default summary", async () => {
		const state = withJudgeAndDecision();
		const exec: PostReviewExec = vi.fn(async () => undefined);
		await postReviewAction({
			state,
			event: "COMMENT",
			body: "Custom summary up top",
			exec,
		});
		const arg = (exec as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(arg.body).toContain("Custom summary up top");
	});

	it("surfaces exec failures as action errors", async () => {
		const state = withJudgeAndDecision();
		const exec: PostReviewExec = vi.fn(async () => {
			throw new Error("gh api 422");
		});
		const result = await postReviewAction({
			state,
			event: "COMMENT",
			exec,
		});
		expect(expectFailure(result).error).toMatch(/gh api 422|post.*failed/i);
	});
});

describe("buildReviewPayload with stack findings", () => {
	// Phase 2: stack-critic findings whose `homePrNumber`
	// matches the cursor PR get posted alongside per-PR
	// findings, in the body section (they are scope-level
	// by nature). Stack findings home to OTHER PRs in the
	// stack get skipped with a clear reason — the user
	// posts those by navigating to the home PR.

	function baseState() {
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 42 },
			loadedAt: "x",
			metadata: prMetadata({
				title: "t",
				url: "u",
				author: "a",
				base: { ref: "main", sha: "d" },
				head: { ref: "feat", sha: "h" },
			}),
			files: [],
			stack: null,
		};
		state.council.lastJudge = judge([]);
		return state;
	}

	it("posts a stack finding when its homePrNumber matches the cursor PR", () => {
		const state = baseState();
		state.stackCritic = stackCriticRun([
			stackFinding(1, "Inconsistent retries", 42, [42, 43]),
		]);
		state.stackDecisions.set(1, {
			findingId: 1,
			verdict: "endorse",
			decidedAt: "x",
		});

		const payload = buildReviewPayload(state);
		expect(payload.body).toContain("Inconsistent retries");
		expect(payload.body).toMatch(/spans|42.*43|cross-PR/i);
		expect(payload.includedStackFindingIds).toEqual([1]);
	});

	it("skips a stack finding when its homePrNumber differs from the cursor PR", () => {
		const state = baseState();
		state.stackCritic = stackCriticRun([
			stackFinding(1, "Belongs on PR 43", 43, [42, 43]),
		]);
		state.stackDecisions.set(1, {
			findingId: 1,
			verdict: "endorse",
			decidedAt: "x",
		});

		const payload = buildReviewPayload(state);
		expect(payload.includedStackFindingIds).toEqual([]);
		const skip = payload.skipped.find(
			(s) => s.findingId === 1 && /stack/.test(s.reason),
		);
		expect(skip).toBeDefined();
		expect(skip?.reason).toMatch(/#43|home/i);
	});

	it("skips pending and dismissed stack findings", () => {
		const state = baseState();
		state.stackCritic = stackCriticRun([
			stackFinding(1, "Pending", 42, [42]),
			stackFinding(2, "Dismissed", 42, [42]),
		]);
		state.stackDecisions.set(2, {
			findingId: 2,
			verdict: "dismiss",
			reason: "out of scope",
			decidedAt: "x",
		});

		const payload = buildReviewPayload(state);
		expect(payload.includedStackFindingIds).toEqual([]);
		expect(payload.skipped).toHaveLength(2);
	});

	it("leaves includedStackFindingIds empty when there is no stack-critic run", () => {
		const state = baseState();
		const payload = buildReviewPayload(state);
		expect(payload.includedStackFindingIds).toEqual([]);
	});

	it("posts a stack-only review when no per-PR findings are eligible", async () => {
		// The user might run stack-critic without any
		// per-PR decisions on the current cursor. Should
		// still post the cross-PR findings.
		const state = baseState();
		state.stackCritic = stackCriticRun([
			stackFinding(1, "Cross-PR pattern", 42, [42, 43]),
		]);
		state.stackDecisions.set(1, {
			findingId: 1,
			verdict: "endorse",
			decidedAt: "x",
		});

		const exec: PostReviewExec = vi.fn(async () => undefined);
		const result = await postReviewAction({
			state,
			event: "COMMENT",
			exec,
		});
		expect(result.ok).toBe(true);
		expect(exec).toHaveBeenCalled();
		const arg = (exec as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(arg.body).toContain("Cross-PR pattern");
		expect(arg.body).toMatch(/cross-PR finding/i);
	});
});
