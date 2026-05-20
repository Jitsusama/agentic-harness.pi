/**
 * Tests for pr-workflow session persistence.
 *
 * Pi reloads extensions on `/reload`, which wipes
 * in-memory state. lifecycle.ts re-hydrates the
 * reconfiguration-expensive bits — roster, judge,
 * stack-critic, loaded PR reference — from session
 * history.
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
import { persist, restore } from "../../../extensions/pr-workflow/lifecycle.js";
import type { CouncilReviewer } from "../../../extensions/pr-workflow/reviewer.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
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

describe("pr-workflow lifecycle", () => {
	describe("restore", () => {
		it("is a no-op when no entry has been written", () => {
			const state = createPrWorkflowState();
			const entries: Entry[] = [];

			restore(state, makeApi(entries), makeCtx(entries));

			expect(state.council.roster).toEqual([]);
			expect(state.council.judge).toBeNull();
			expect(state.council.stackCritic).toBeNull();
			expect(state.pr).toBeNull();
		});

		it("rehydrates roster, judge and stack-critic config", () => {
			const entries: Entry[] = [];
			const pi = makeApi(entries);
			const ctx = makeCtx(entries);

			const source = createPrWorkflowState();
			source.council.roster = [sampleReviewer("alpha")];
			source.council.judge = sampleReviewer("judge");
			source.council.stackCritic = sampleReviewer("critic");
			persist(source, pi);

			const restored = createPrWorkflowState();
			restore(restored, pi, ctx);

			expect(restored.council.roster).toEqual([sampleReviewer("alpha")]);
			expect(restored.council.judge).toEqual(sampleReviewer("judge"));
			expect(restored.council.stackCritic).toEqual(sampleReviewer("critic"));
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
			// Derived data is re-fetched on next interaction,
			// not persisted: keeps the wire format small and
			// avoids schema drift on PrMetadata / DiffFile.
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
	});

	describe("persist", () => {
		it("does not write run output, decisions or thread snapshots", () => {
			// Guard against accidentally persisting the
			// expensive-to-serialize state (Map-keyed
			// findings/decisions) when adding new fields.
			// If this test fails, either intentionally widen
			// the persisted shape or back the change out.
			const entries: Entry[] = [];
			const pi = makeApi(entries);

			const state = createPrWorkflowState();
			state.council.roster = [sampleReviewer("alpha")];
			persist(state, pi);

			expect(entries).toHaveLength(1);
			const written = entries[0]?.data as Record<string, unknown>;
			expect(written).not.toHaveProperty("decisions");
			expect(written).not.toHaveProperty("stackDecisions");
			expect(written).not.toHaveProperty("stackRuns");
			expect(written).not.toHaveProperty("threads");
			expect(written).not.toHaveProperty("lastRun");
			expect(written).not.toHaveProperty("lastJudge");
			expect(written).not.toHaveProperty("lastCritique");
		});
	});
});
