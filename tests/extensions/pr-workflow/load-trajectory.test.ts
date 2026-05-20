import { describe, expect, it } from "vitest";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import {
	formatLoadSuggestions,
	suggestNextAfterLoad,
} from "../../../extensions/pr-workflow/load-trajectory.js";
import type { Stack } from "../../../extensions/pr-workflow/stack.js";
import {
	createPrWorkflowState,
	type PrWorkflowState,
} from "../../../extensions/pr-workflow/state.js";

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

function finding(id: number): Finding {
	return {
		id,
		location: { kind: "global" },
		label: "issue",
		decorations: [],
		subject: "s",
		discussion: "d",
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

function stackWith(count: number): Stack {
	return {
		entries: Array.from({ length: count }, (_, i) => ({
			reference: { owner: "o", repo: "r", number: 1000 + i },
			title: `PR ${i}`,
			baseRefName: "main",
			headRefName: `f${i}`,
		})),
		cursorIndex: 0,
		cursorChildren: [],
	};
}

describe("suggestNextAfterLoad", () => {
	it("returns no hints when no PR is loaded", () => {
		expect(suggestNextAfterLoad(createPrWorkflowState())).toEqual([]);
	});

	it("suggests council-config when no roster is configured", () => {
		const state = loadedState();
		const hints = suggestNextAfterLoad(state);
		expect(hints[0]?.action).toBe("council-config");
	});

	it("suggests council when a roster is configured but no judge has run", () => {
		const state = loadedState();
		state.council.roster = [
			{ id: "fast", model: "x", tools: ["read"], thinkingLevel: undefined },
		];
		const hints = suggestNextAfterLoad(state);
		expect(hints[0]?.action).toBe("council");
	});

	it("suggests findings when a judge run has pending decisions", () => {
		const state = loadedState();
		state.council.roster = [
			{ id: "fast", model: "x", tools: ["read"], thinkingLevel: undefined },
		];
		state.council.lastJudge = judgeWith([finding(1), finding(2)]);
		const hints = suggestNextAfterLoad(state);
		expect(hints[0]?.action).toBe("findings");
		expect(hints[0]?.rationale).toContain("2 of 2");
	});

	it("appends review when the PR is part of a stack", () => {
		const state = loadedState();
		if (state.pr) state.pr.stack = stackWith(3);
		const hints = suggestNextAfterLoad(state);
		expect(hints.some((h) => h.action === "review")).toBe(true);
	});

	it("does not suggest review for a single-PR 'stack'", () => {
		const state = loadedState();
		if (state.pr) state.pr.stack = stackWith(1);
		const hints = suggestNextAfterLoad(state);
		expect(hints.some((h) => h.action === "review")).toBe(false);
	});

	it("always falls through to threads as the last hint", () => {
		const state = loadedState();
		const hints = suggestNextAfterLoad(state);
		expect(hints[hints.length - 1]?.action).toBe("threads");
	});

	it("caps the hint list at three entries", () => {
		const state = loadedState();
		if (state.pr) state.pr.stack = stackWith(4);
		state.council.roster = [
			{ id: "fast", model: "x", tools: ["read"], thinkingLevel: undefined },
		];
		state.council.lastJudge = judgeWith([finding(1)]);
		const hints = suggestNextAfterLoad(state);
		expect(hints.length).toBeLessThanOrEqual(3);
	});
});

describe("formatLoadSuggestions", () => {
	it("returns nothing for an empty list", () => {
		expect(formatLoadSuggestions([])).toEqual([]);
	});

	it("prepends a 'Next:' header and bullets each suggestion", () => {
		const lines = formatLoadSuggestions([
			{ action: "council-config", rationale: "Configure the roster." },
			{ action: "threads", rationale: "Check feedback." },
		]);
		expect(lines).toEqual([
			"",
			"Next:",
			"  • action=council-config — Configure the roster.",
			"  • action=threads — Check feedback.",
		]);
	});
});
