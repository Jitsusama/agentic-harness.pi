import { describe, expect, it } from "vitest";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import {
	createPrWorkflowState,
	type PrWorkflowState,
	resetPrWorkflowSession,
} from "../../../extensions/pr-workflow/state.js";
import { renderPrStatusLine } from "../../../extensions/pr-workflow/status-line.js";
import { decideFinding } from "../../../extensions/pr-workflow/synthesis.js";
import { fakeTheme } from "../../lib/ui/fake-theme.js";

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
		subject: "x",
		discussion: "y",
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

describe("renderPrStatusLine", () => {
	it("returns undefined when no PR is loaded", () => {
		const state = createPrWorkflowState();
		expect(renderPrStatusLine(state, fakeTheme())).toBeUndefined();
	});

	it("includes the PR number when a PR is loaded", () => {
		const line = renderPrStatusLine(loadedState(), fakeTheme());
		expect(line).toBeDefined();
		expect(line).toContain("PR1234");
	});

	it("appends the finding count when the judge has consolidated findings", () => {
		const state = loadedState();
		state.council.lastJudge = judgeWith([finding(1), finding(2), finding(3)]);
		const line = renderPrStatusLine(state, fakeTheme());
		expect(line).toContain("3F");
	});

	it("omits the finding segment when no judge run has happened", () => {
		const state = loadedState();
		const line = renderPrStatusLine(state, fakeTheme());
		expect(line).not.toMatch(/\d+F/);
	});

	it("appends the fix queue depth when there are pending fixes", () => {
		const state = loadedState();
		state.council.lastJudge = judgeWith([finding(1), finding(2)]);
		decideFinding(state, { findingId: 1, verdict: "fix" });
		const line = renderPrStatusLine(state, fakeTheme());
		expect(line).toContain("1Q");
	});

	it("omits the queue segment when no pending fixes remain", () => {
		const state = loadedState();
		state.council.lastJudge = judgeWith([finding(1)]);
		const line = renderPrStatusLine(state, fakeTheme());
		expect(line).not.toMatch(/\d+Q/);
	});

	it("disappears after the workflow session is reset", () => {
		const state = loadedState();
		state.council.lastJudge = judgeWith([finding(1)]);

		resetPrWorkflowSession(state);

		expect(renderPrStatusLine(state, fakeTheme())).toBeUndefined();
	});
});
