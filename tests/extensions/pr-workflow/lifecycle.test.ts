/**
 * Tests for pr-workflow session persistence.
 *
 * Pi reloads extensions on `/reload`, which wipes
 * in-memory state. lifecycle.ts re-hydrates the
 * configuration AND the run history so the user can
 * resume a Round-4 decision flow or a fix loop after
 * a reload mid-session.
 *
 * These tests assert observable behaviour through the
 * persist/restore API. The wire format is an
 * implementation detail; tests work in terms of
 * "what survives a reload".
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { CritiqueRun } from "../../../extensions/pr-workflow/critique.js";
import type {
	CouncilRun,
	Finding,
} from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import { persist, restore } from "../../../extensions/pr-workflow/lifecycle.js";
import type { CouncilReviewer } from "../../../extensions/pr-workflow/reviewer.js";
import type { StackFindingRun } from "../../../extensions/pr-workflow/stack-findings.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import type { FindingDecision } from "../../../extensions/pr-workflow/synthesis.js";
import type { ReviewThread } from "../../../extensions/pr-workflow/threads.js";
import type { PRReference } from "../../../lib/internal/github/pr-reference.js";

interface Entry {
	type: string;
	customType?: string;
	data?: unknown;
}

function makeApi(entries: Entry[]): ExtensionAPI {
	return {
		appendEntry(name: string, data: unknown) {
			entries.push({ type: "custom", customType: name, data });
		},
	} as unknown as ExtensionAPI;
}

function makeCtx(entries: Entry[]): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => entries,
		},
	} as unknown as ExtensionContext;
}

function sampleReviewer(id: string): CouncilReviewer {
	return {
		id,
		model: "anthropic/claude-sonnet-4-5",
		tools: ["read", "grep"],
	};
}

function sampleRef(): PRReference {
	return {
		owner: "Jitsusama",
		repo: "pr-workflow-fixtures",
		number: 3,
	};
}

function sampleFinding(id: number): Finding {
	return {
		id,
		location: { kind: "file", file: "task.go" },
		label: "issue",
		decorations: [],
		subject: `subject ${id}`,
		discussion: `discussion ${id}`,
		category: "file",
		origin: { kind: "judge", runId: "j-1", judgeReviewerId: "judge" },
		state: "draft",
		agreement: { raisedBy: ["alpha"], sourceFindingIds: [id] },
	};
}

function sampleCouncilRun(): CouncilRun {
	return {
		id: "c-1",
		startedAt: "2026-05-20T14:00:00Z",
		target: { kind: "diff", prNumber: 3 },
		reviewerOutputs: [
			{
				reviewerId: "alpha",
				findings: [sampleFinding(1)],
				warnings: [],
			},
		],
	};
}

function sampleJudgeRun(): JudgeRun {
	return {
		id: "j-1",
		startedAt: "2026-05-20T14:05:00Z",
		judgeReviewerId: "judge",
		selfSignal: null,
		consolidatedFindings: [sampleFinding(1), sampleFinding(2)],
		warnings: [],
	};
}

function sampleCritiqueRun(): CritiqueRun {
	return {
		id: "cr-1",
		startedAt: "2026-05-20T14:10:00Z",
		judgeRunId: "j-1",
		reviewerOutputs: [
			{
				reviewerId: "alpha",
				critiques: [
					{
						reviewerId: "alpha",
						findingId: 1,
						position: "agree",
						rationale: "yes",
					},
				],
				warnings: [],
			},
		],
		warnings: [],
	};
}

function sampleStackFindingRun(): StackFindingRun {
	return {
		id: "sc-1",
		startedAt: "2026-05-20T14:15:00Z",
		reviewerId: "critic",
		findings: [{ ...sampleFinding(101), homePrNumber: 3, spans: [3, 4] }],
		warnings: [],
	};
}

function endorseDecision(findingId: number): FindingDecision {
	return {
		findingId,
		verdict: "endorse",
		decidedAt: "2026-05-20T14:20:00Z",
	};
}

function fixDecision(findingId: number): FindingDecision {
	return {
		findingId,
		verdict: "fix",
		decidedAt: "2026-05-20T14:21:00Z",
	};
}

function reviewThread(): ReviewThread {
	return {
		id: "T1",
		kind: "review-thread",
		isResolved: false,
		isOutdated: false,
		path: "task.go",
		line: 10,
		comments: [
			{
				id: "C1",
				author: "reviewer",
				body: "please reconsider",
				createdAt: "2026-05-20T13:00:00Z",
				url: "https://github.com/o/r/pull/3#discussion_r1",
			},
		],
	};
}

describe("pr-workflow lifecycle", () => {
	describe("restore", () => {
		it("is a no-op when no entry has been written", () => {
			const state = createPrWorkflowState();
			const entries: Entry[] = [];

			restore(state, makeApi(entries), makeCtx(entries));

			expect(state.council.roster).toEqual([]);
			expect(state.council.judge).toBeNull();
			expect(state.pr).toBeNull();
			expect(state.council.lastRun).toBeNull();
			expect(state.council.lastJudge).toBeNull();
			expect(state.council.lastCritique).toBeNull();
			expect(state.council.decisions.size).toBe(0);
			expect(state.stackFindingRun).toBeNull();
			expect(state.stackDecisions.size).toBe(0);
			expect(state.stackRuns.size).toBe(0);
			expect(state.threads).toBeNull();
		});

		it("rehydrates roster and judge config", () => {
			const entries: Entry[] = [];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const source = createPrWorkflowState();
			source.council.roster = [sampleReviewer("alpha")];
			source.council.judge = sampleReviewer("judge");
			persist(source, pi);

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			expect(restored.council.roster).toEqual([sampleReviewer("alpha")]);
			expect(restored.council.judge).toEqual(sampleReviewer("judge"));
		});

		it("rehydrates the loaded PR reference with null derived data", () => {
			const entries: Entry[] = [];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const source = createPrWorkflowState();
			source.pr = {
				reference: sampleRef(),
				loadedAt: "2026-05-20T14:00:00.000Z",
				metadata: null,
				files: null,
				stack: null,
			};
			persist(source, pi);

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			expect(restored.pr).not.toBeNull();
			expect(restored.pr?.reference).toEqual(sampleRef());
			expect(restored.pr?.loadedAt).toBe("2026-05-20T14:00:00.000Z");
			expect(restored.pr?.metadata).toBeNull();
			expect(restored.pr?.files).toBeNull();
			expect(restored.pr?.stack).toBeNull();
		});

		it("uses the most recent persisted entry when multiple exist", () => {
			const entries: Entry[] = [];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const first = createPrWorkflowState();
			first.council.roster = [sampleReviewer("old")];
			persist(first, pi);

			const second = createPrWorkflowState();
			second.council.roster = [sampleReviewer("new")];
			persist(second, pi);

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			expect(restored.council.roster).toEqual([sampleReviewer("new")]);
		});

		it("rehydrates the most recent council, judge and critique runs", () => {
			const entries: Entry[] = [];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const source = createPrWorkflowState();
			source.council.lastRun = sampleCouncilRun();
			source.council.lastJudge = sampleJudgeRun();
			source.council.lastCritique = sampleCritiqueRun();
			persist(source, pi);

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			expect(restored.council.lastRun).toEqual(sampleCouncilRun());
			expect(restored.council.lastJudge).toEqual(sampleJudgeRun());
			expect(restored.council.lastCritique).toEqual(sampleCritiqueRun());
		});

		it("rehydrates per-PR Round-4 decisions across a reload", () => {
			const entries: Entry[] = [];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const source = createPrWorkflowState();
			source.council.decisions.set(1, endorseDecision(1));
			source.council.decisions.set(2, fixDecision(2));
			persist(source, pi);

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			expect(restored.council.decisions.size).toBe(2);
			expect(restored.council.decisions.get(1)).toEqual(endorseDecision(1));
			expect(restored.council.decisions.get(2)).toEqual(fixDecision(2));
		});

		it("rehydrates the cross-PR run and stack-level decisions", () => {
			const entries: Entry[] = [];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const source = createPrWorkflowState();
			source.stackFindingRun = sampleStackFindingRun();
			source.stackDecisions.set(101, endorseDecision(101));
			persist(source, pi);

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			expect(restored.stackFindingRun).toEqual(sampleStackFindingRun());
			expect(restored.stackDecisions.get(101)).toEqual(endorseDecision(101));
		});

		it("rehydrates per-PR run snapshots stashed on cursor moves", () => {
			const entries: Entry[] = [];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const source = createPrWorkflowState();
			source.stackRuns.set(7, {
				lastRun: sampleCouncilRun(),
				lastJudge: sampleJudgeRun(),
				lastCritique: null,
				decisions: new Map([[1, endorseDecision(1)]]),
			});
			persist(source, pi);

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			const snap = restored.stackRuns.get(7);
			expect(snap).toBeDefined();
			expect(snap?.lastRun).toEqual(sampleCouncilRun());
			expect(snap?.lastJudge).toEqual(sampleJudgeRun());
			expect(snap?.decisions.get(1)).toEqual(endorseDecision(1));
		});

		it("rehydrates the threads snapshot", () => {
			const entries: Entry[] = [];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const source = createPrWorkflowState();
			source.threads = {
				prNumber: 3,
				fetchedAt: "2026-05-20T13:30:00Z",
				mutatedAt: null,
				threads: [reviewThread()],
			};
			persist(source, pi);

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			expect(restored.threads).not.toBeNull();
			expect(restored.threads?.prNumber).toBe(3);
			expect(restored.threads?.threads).toEqual([reviewThread()]);
		});

		it("rehydrates the session-global finding id allocator", () => {
			const entries: Entry[] = [];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const source = createPrWorkflowState();
			source.nextFindingId = 42;
			persist(source, pi);

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			expect(restored.nextFindingId).toBe(42);
		});

		it("rehydrates locked participant identities", () => {
			const entries: Entry[] = [];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const source = createPrWorkflowState();
			source.participantIdentities.set("fast", {
				id: "fast",
				role: "reviewer",
				model: "model-a",
				tools: ["read"],
			});
			persist(source, pi);

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			expect(restored.participantIdentities.get("fast")).toEqual({
				id: "fast",
				role: "reviewer",
				model: "model-a",
				tools: ["read"],
			});
		});

		it("infers the next finding id from old run-history entries", () => {
			const entries: Entry[] = [];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const source = createPrWorkflowState();
			source.council.lastJudge = sampleJudgeRun();
			source.stackFindingRun = sampleStackFindingRun();
			persist(source, pi);
			if (entries[0]?.data && typeof entries[0].data === "object") {
				delete (entries[0].data as { nextFindingId?: number }).nextFindingId;
			}

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			expect(restored.nextFindingId).toBe(102);
		});

		it("treats a v0 (Phase 1) entry as config-only without crashing", () => {
			// v0 entries lack a `version` field and only
			// carry roster/judge/prReference.
			// Restoring them must not throw or corrupt
			// state for the fields they don't cover.
			const entries: Entry[] = [
				{
					type: "custom",
					customType: "pr-workflow",
					data: {
						roster: [sampleReviewer("alpha")],
						judge: sampleReviewer("judge"),
						stackFindingRun: null,
						prReference: null,
						prLoadedAt: null,
					},
				},
			];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			expect(restored.council.roster).toEqual([sampleReviewer("alpha")]);
			expect(restored.council.judge).toEqual(sampleReviewer("judge"));
			expect(restored.council.lastRun).toBeNull();
			expect(restored.council.lastJudge).toBeNull();
			expect(restored.council.decisions.size).toBe(0);
		});
	});

	describe("persist", () => {
		it("survives a JSON round-trip for the full state shape", () => {
			// Maps and complex run shapes need explicit
			// serialisation. This catches future drift where
			// a new state field skips the conversion path.
			const entries: Entry[] = [];
			const pi = makeApi(entries);

			const source = createPrWorkflowState();
			source.council.roster = [sampleReviewer("alpha")];
			source.council.lastJudge = sampleJudgeRun();
			source.council.decisions.set(1, endorseDecision(1));
			source.stackFindingRun = sampleStackFindingRun();
			source.stackDecisions.set(101, endorseDecision(101));
			source.participantIdentities.set("judge", {
				id: "judge",
				role: "judge",
				model: "model-a",
			});
			source.stackRuns.set(7, {
				lastRun: null,
				lastJudge: null,
				lastCritique: null,
				decisions: new Map([[1, fixDecision(1)]]),
			});
			persist(source, pi);

			const written = entries[0]?.data;
			const roundTripped = JSON.parse(JSON.stringify(written));

			// Replace the in-memory entry with the JSON
			// round-tripped copy and prove restore still
			// works against it.
			entries[0] = {
				type: "custom",
				customType: "pr-workflow",
				data: roundTripped,
			};

			const restored = createPrWorkflowState();
			restore(restored, pi, makeCtx(entries));

			expect(restored.council.decisions.get(1)).toEqual(endorseDecision(1));
			expect(restored.stackDecisions.get(101)).toEqual(endorseDecision(101));
			expect(restored.stackRuns.get(7)?.decisions.get(1)).toEqual(
				fixDecision(1),
			);
			expect(restored.council.lastJudge).toEqual(sampleJudgeRun());
			expect(restored.stackFindingRun).toEqual(sampleStackFindingRun());
			expect(restored.participantIdentities.get("judge")).toEqual({
				id: "judge",
				role: "judge",
				model: "model-a",
			});
		});
	});
});
