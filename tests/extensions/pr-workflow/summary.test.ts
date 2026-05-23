import { describe, expect, it } from "vitest";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import {
	createPrWorkflowState,
	type PrWorkflowState,
} from "../../../extensions/pr-workflow/state.js";
import { formatPrSummary } from "../../../extensions/pr-workflow/summary.js";
import { decideFinding } from "../../../extensions/pr-workflow/synthesis.js";
import type { ReviewThread } from "../../../extensions/pr-workflow/threads.js";

function loadedState(): PrWorkflowState {
	const state = createPrWorkflowState();
	state.active = true;
	state.pr = {
		reference: { owner: "shopify", repo: "world", number: 1234 },
		loadedAt: "2026-05-19T00:00:00Z",
		metadata: null,
		files: null,
		stack: null,
	};
	return state;
}

function loadedPr(state: PrWorkflowState) {
	if (state.pr === null) {
		throw new Error("test setup: expected loadedState() to attach a PR");
	}
	return state.pr;
}

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

function judgeWith(findings: Finding[]): JudgeRun {
	return {
		id: "j-1",
		startedAt: "2026-01-01T00:00:00Z",
		judgeReviewerId: "j",
		selfSignal: null,
		consolidatedFindings: findings,
		warnings: [],
	};
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
	return {
		id: "T1",
		kind: "review-thread",
		isResolved: false,
		isOutdated: false,
		path: "cache.ts",
		line: 12,
		comments: [
			{
				id: "C1",
				author: "alice",
				body: "this cfg shadows the imported module name",
				createdAt: "2026-05-19T00:00:00Z",
				url: "u1",
			},
		],
		...overrides,
	};
}

describe("formatPrSummary", () => {
	it("returns a clear instruction when no PR is loaded", () => {
		const state = createPrWorkflowState();
		expect(formatPrSummary(state)).toContain("No PR loaded");
		expect(formatPrSummary(state)).toContain("action=load");
	});

	it("renders the PR ref and number in the header", () => {
		const state = loadedState();
		const text = formatPrSummary(state);
		expect(text).toContain("shopify/world#1234");
	});

	it("uses a placeholder title when metadata has not been fetched", () => {
		const state = loadedState();
		expect(formatPrSummary(state)).toContain("(metadata not fetched)");
	});

	it("surfaces metadata when fetched: title, author, state, change stats", () => {
		const state = loadedState();
		state.pr = {
			...loadedPr(state),
			metadata: {
				title: "Add cache eviction policy",
				author: "joel",
				state: "OPEN",
				isDraft: false,
				url: "https://example.com/pr/1234",
				body: "",
				base: { ref: "main", sha: "aaa" },
				head: { ref: "feat", sha: "bbb" },
				additions: 120,
				deletions: 30,
				changedFiles: 5,
				createdAt: "2026-05-01T00:00:00Z",
				updatedAt: "2026-05-19T00:00:00Z",
			},
		};
		const text = formatPrSummary(state);
		expect(text).toContain("Add cache eviction policy");
		expect(text).toContain("@joel");
		expect(text).toContain("state: open");
		expect(text).toContain("+120 -30");
		expect(text).toContain("5 file");
	});

	it("labels the state as 'draft' when isDraft is true", () => {
		const state = loadedState();
		state.pr = {
			...loadedPr(state),
			metadata: {
				title: "WIP",
				author: "joel",
				state: "OPEN",
				isDraft: true,
				url: "",
				body: "",
				base: { ref: "main", sha: "a" },
				head: { ref: "feat", sha: "b" },
				additions: 0,
				deletions: 0,
				changedFiles: 0,
				createdAt: "2026-05-19T00:00:00Z",
				updatedAt: "2026-05-19T00:00:00Z",
			},
		};
		expect(formatPrSummary(state)).toContain("state: draft");
	});

	it("hints the user to fetch threads when none have been fetched", () => {
		const state = loadedState();
		const text = formatPrSummary(state);
		expect(text).toContain("Threads:");
		expect(text).toContain("not fetched");
		expect(text).toContain("action=threads");
	});

	it("says 'none on this PR' when the threads snapshot is empty", () => {
		const state = loadedState();
		state.threads = {
			prNumber: 1234,
			fetchedAt: "2026-05-19T00:00:00Z",
			mutatedAt: null,
			threads: [],
		};
		expect(formatPrSummary(state)).toContain("Threads: none on this PR");
	});

	it("counts open / resolved / outdated threads separately", () => {
		const state = loadedState();
		state.threads = {
			prNumber: 1234,
			fetchedAt: "2026-05-19T00:00:00Z",
			mutatedAt: null,
			threads: [
				thread({ id: "T1" }),
				thread({ id: "T2", isResolved: true }),
				thread({ id: "T3", isOutdated: true }),
			],
		};
		expect(formatPrSummary(state)).toContain(
			"Threads: 1 open, 1 resolved, 1 outdated",
		);
	});

	it("previews open threads with index, location, author and excerpt", () => {
		const state = loadedState();
		state.threads = {
			prNumber: 1234,
			fetchedAt: "2026-05-19T00:00:00Z",
			mutatedAt: null,
			threads: [thread()],
		};
		const text = formatPrSummary(state);
		expect(text).toContain("[T1]");
		expect(text).toContain("cache.ts:12");
		expect(text).toContain("@alice");
		expect(text).toContain("shadows the imported module name");
	});

	it("labels the threads block with its fetched-at timestamp", () => {
		const state = loadedState();
		state.threads = {
			prNumber: 1234,
			fetchedAt: "2026-05-19T00:00:00Z",
			mutatedAt: null,
			threads: [thread()],
		};
		const text = formatPrSummary(state);
		expect(text).toContain("cached 2026-05-19T00:00:00Z");
		expect(text).toContain("re-run `action=threads` to refresh");
	});

	it("surfaces 'updated locally' when in-session mutations have happened", () => {
		const state = loadedState();
		state.threads = {
			prNumber: 1234,
			fetchedAt: "2026-05-19T00:00:00Z",
			mutatedAt: "2026-05-19T10:00:00Z",
			threads: [thread({ isResolved: true })],
		};
		const text = formatPrSummary(state);
		expect(text).toContain("updated locally 2026-05-19T10:00:00Z");
	});

	it("caps the preview and tells the user how many were omitted", () => {
		const state = loadedState();
		const threads: ReviewThread[] = [];
		for (let i = 1; i <= 5; i += 1) {
			threads.push(thread({ id: `T${i}` }));
		}
		state.threads = {
			prNumber: 1234,
			fetchedAt: "2026-05-19T00:00:00Z",
			mutatedAt: null,
			threads,
		};
		const text = formatPrSummary(state);
		expect(text).toContain("(+2 more open;");
	});

	it("reports the council roster and judge when configured", () => {
		const state = loadedState();
		state.council.roster = [
			{ id: "fast", model: "claude-haiku" },
			{ id: "deep", model: "claude-opus" },
		];
		state.council.judge = { id: "judge", model: "gpt" };
		const text = formatPrSummary(state);
		expect(text).toContain("2 reviewer");
		expect(text).toContain("[fast, deep]");
		expect(text).toContain("judge: judge");
	});

	it("says 'unconfigured' when no roster is set", () => {
		expect(formatPrSummary(loadedState())).toContain("unconfigured");
	});

	it("says 'no council run yet' when no rounds have completed", () => {
		expect(formatPrSummary(loadedState())).toContain("no council run yet");
	});

	it("reports round 1, 2, 3 progress as runs land", () => {
		const state = loadedState();
		state.council.lastJudge = judgeWith([
			judgedFinding(1, "A"),
			judgedFinding(2, "B"),
		]);
		const text = formatPrSummary(state);
		expect(text).toContain("round 2 (judge): 2 consolidated");
	});

	it("breaks down decisions by verdict when any exist", () => {
		const state = loadedState();
		state.council.lastJudge = judgeWith([
			judgedFinding(1, "A"),
			judgedFinding(2, "B"),
		]);
		decideFinding(state, { findingId: 1, verdict: "fix", scope: "pr" });
		decideFinding(state, {
			findingId: 2,
			verdict: "dismiss",
			reason: "false positive",
			scope: "pr",
		});
		const text = formatPrSummary(state);
		expect(text).toContain("decisions: 2");
		expect(text).toContain("1 fix");
		expect(text).toContain("1 dismiss");
	});

	it("omits the fix queue line when nothing is queued", () => {
		expect(formatPrSummary(loadedState())).not.toContain("Fix queue");
	});

	it("renders supervised reviewer recovery counts when present", () => {
		const state = loadedState();
		state.reviewerRecovery = {
			completed: [
				{
					runId: "run",
					reviewerId: "fast",
					state: "complete",
					exitCode: 0,
					finalAssistantText: "done",
					warnings: [],
					resultPath: "/tmp/result.json",
				},
			],
			active: [],
			stale: [
				{
					runId: "run",
					reviewerId: "slow",
					state: "running",
					activity: "reading x",
					updatedAt: "2026-01-01T00:00:00Z",
				},
			],
			warnings: ["one stale reviewer was cancelled"],
		};

		const text = formatPrSummary(state);

		expect(text).toContain("Reviewer recovery: 1 completed, 0 active, 1 stale");
		expect(text).toContain("warning: one stale reviewer was cancelled");
	});

	it("renders the fix queue with counts when decisions exist", () => {
		const state = loadedState();
		state.council.lastJudge = judgeWith([judgedFinding(1, "A")]);
		decideFinding(state, { findingId: 1, verdict: "fix", scope: "pr" });
		const text = formatPrSummary(state);
		expect(text).toContain("Fix queue: 1 pending");
	});

	it("omits the stack section when not part of a stack", () => {
		expect(formatPrSummary(loadedState())).not.toContain("Stack:");
	});

	it("renders the stack with cursor marker when part of a multi-PR stack", () => {
		const state = loadedState();
		state.pr = {
			...loadedPr(state),
			stack: {
				entries: [
					{
						reference: { owner: "shopify", repo: "world", number: 1230 },
						title: "Base PR",
						baseRefName: "main",
						headRefName: "f1",
					},
					{
						reference: { owner: "shopify", repo: "world", number: 1234 },
						title: "Cursor PR",
						baseRefName: "f1",
						headRefName: "f2",
					},
					{
						reference: { owner: "shopify", repo: "world", number: 1236 },
						title: "Tip PR",
						baseRefName: "f2",
						headRefName: "f3",
					},
				],
				cursorIndex: 1,
				cursorChildren: [],
			},
		};
		const text = formatPrSummary(state);
		expect(text).toContain("Stack:");
		expect(text).toContain("→ 2/3 #1234 Cursor PR");
		expect(text).toContain("  1/3 #1230 Base PR");
		expect(text).toContain("  3/3 #1236 Tip PR");
	});
});
