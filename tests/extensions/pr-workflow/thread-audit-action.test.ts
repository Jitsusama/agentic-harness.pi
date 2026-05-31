import { describe, expect, it } from "vitest";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import {
	auditThreadsAction,
	formatThreadAudit,
} from "../../../extensions/pr-workflow/thread-audit-action.js";
import type { ReviewThread } from "../../../extensions/pr-workflow/threads.js";
import {
	type WorktreeProvider,
	WorktreeRegistry,
} from "../../../extensions/pr-workflow/worktree.js";
import { expectFailure, prMetadata } from "./fixtures.js";

function fakeProvider(): WorktreeProvider {
	return {
		id: "fake",
		async ensure(req) {
			return {
				path: `/wt/${req.sha}`,
				sha: req.sha,
				providerId: "fake",
				reusable: true,
				createdAt: new Date(0),
			};
		},
		async release() {},
	};
}

const AUDITOR = { id: "auditor", model: "m" };

function reviewThread(over: Partial<ReviewThread> = {}): ReviewThread {
	return {
		id: "T_1",
		kind: "review-thread",
		isResolved: false,
		isOutdated: false,
		path: "src/auth.ts",
		line: 42,
		comments: [
			{
				id: "C_1",
				author: "reviewer",
				body: "Rename this field.",
				createdAt: "2026-01-01T00:00:00Z",
				url: "https://example/c1",
			},
		],
		...over,
	};
}

function loadedState() {
	const state = createPrWorkflowState();
	state.pr = {
		reference: { owner: "o", repo: "r", number: 42 },
		loadedAt: "2026-01-01T00:00:00Z",
		metadata: prMetadata({ head: { ref: "feat", sha: "headsha" } }),
		files: [],
		stack: null,
	};
	return state;
}

const verdictResponse = (verdicts: unknown) => ({
	reviewerId: "auditor",
	exitCode: 0,
	finalAssistantText: ["```json", JSON.stringify({ verdicts }), "```"].join(
		"\n",
	),
	stderr: "",
	warnings: [],
});

describe("auditThreadsAction", () => {
	it("refuses without a loaded PR", async () => {
		const state = createPrWorkflowState();
		const result = await auditThreadsAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			auditor: AUDITOR,
			fetchThreads: async () => [],
			dispatch: async () => {
				throw new Error("should not dispatch");
			},
		});
		expect(expectFailure(result).error).toMatch(/no pr|load/i);
	});

	it("returns an empty advisory when there are no unresolved threads", async () => {
		const state = loadedState();
		const result = await auditThreadsAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			auditor: AUDITOR,
			fetchThreads: async () => [reviewThread({ isResolved: true })],
			dispatch: async () => {
				throw new Error("should not dispatch when nothing to audit");
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.verdicts).toEqual([]);
	});

	it("audits unresolved threads and returns parsed verdicts", async () => {
		const state = loadedState();
		let captured = "";
		const result = await auditThreadsAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			auditor: AUDITOR,
			fetchThreads: async () => [reviewThread()],
			dispatch: async (opts) => {
				captured = opts.prompt;
				return verdictResponse([
					{
						threadId: "T_1",
						disposition: "addressed",
						rationale: "Downstream PR renames it.",
					},
				]);
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.verdicts).toHaveLength(1);
		expect(result.verdicts[0].disposition).toBe("addressed");
		// The thread reached the prompt.
		expect(captured).toContain("T_1");
		expect(captured).toContain("Rename this field.");
	});

	it("skips resolved and PR-level threads", async () => {
		const state = loadedState();
		let captured = "";
		await auditThreadsAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			auditor: AUDITOR,
			fetchThreads: async () => [
				reviewThread({ id: "T_keep" }),
				reviewThread({ id: "T_resolved", isResolved: true }),
				reviewThread({ id: "T_prlevel", kind: "review-level" }),
			],
			dispatch: async (opts) => {
				captured = opts.prompt;
				return verdictResponse([]);
			},
		});
		expect(captured).toContain("T_keep");
		expect(captured).not.toContain("T_resolved");
		expect(captured).not.toContain("T_prlevel");
	});
});

describe("formatThreadAudit", () => {
	it("groups verdicts by disposition, addressed first", () => {
		const text = formatThreadAudit([
			{ threadId: "T_v", disposition: "valid", rationale: "still open" },
			{ threadId: "T_a", disposition: "addressed", rationale: "stack does it" },
		]);
		expect(text.indexOf("Already addressed")).toBeLessThan(
			text.indexOf("Still valid"),
		);
		expect(text).toContain("[T_a] stack does it");
		expect(text).toContain("[T_v] still open");
	});

	it("renders the display index and a ready-to-send draft when given a map", () => {
		const text = formatThreadAudit(
			[
				{
					threadId: "T_a",
					disposition: "addressed",
					rationale: "stack does it",
					draftReply: "Handled in #43.",
				},
			],
			new Map([["T_a", 2]]),
		);
		// The actionable display index, not the raw thread id.
		expect(text).toContain("[T2]");
		// The draft reply is surfaced so the user can post it.
		expect(text).toContain("Handled in #43.");
		// And it points at how to act on it in one step.
		expect(text).toMatch(/reply|resolve/i);
	});

	it("says so when there is nothing to report", () => {
		expect(formatThreadAudit([])).toMatch(/no unresolved/i);
	});
});
