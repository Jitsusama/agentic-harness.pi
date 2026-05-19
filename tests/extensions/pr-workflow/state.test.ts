import { describe, expect, it } from "vitest";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";

describe("createPrWorkflowState", () => {
	it("starts disengaged with no PR loaded", () => {
		// A fresh session has the workflow off and no PR in the
		// slot. Pinning these defaults catches accidental
		// auto-engagement at startup, which would be a serious
		// surprise for the user.
		const state = createPrWorkflowState();
		expect(state.active).toBe(false);
		expect(state.pr).toBeNull();
	});

	it("starts with no review-threads snapshot", () => {
		// Threads are a per-PR concern but live on the
		// top-level state. A fresh session has nothing
		// fetched yet.
		const state = createPrWorkflowState();
		expect(state.threads).toBeNull();
	});

	it("starts with no stack-critic reviewer, run, or decisions", () => {
		// Phase 1+2 of stack-aware review adds three slots
		// to the council/state shape: a configurable stack
		// critic reviewer (separate from judge), the most
		// recent run, and the decision map for stack-level
		// findings. Fresh sessions should have none of them
		// populated.
		const state = createPrWorkflowState();
		expect(state.council.stackCritic).toBeNull();
		expect(state.stackCritic).toBeNull();
		expect(state.stackDecisions.size).toBe(0);
	});

	it("returns an independent state object on every call", () => {
		// State is created fresh each time so callers can't
		// accidentally share a mutable singleton. Each session
		// owns its own copy.
		const a = createPrWorkflowState();
		const b = createPrWorkflowState();
		expect(a).not.toBe(b);
		a.active = true;
		expect(b.active).toBe(false);
		a.stackDecisions.set(1, {
			findingId: 1,
			verdict: "endorse",
			decidedAt: "2026-05-19T00:00:00Z",
		});
		expect(b.stackDecisions.size).toBe(0);
	});
});
