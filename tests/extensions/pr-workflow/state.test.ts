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

	it("returns an independent state object on every call", () => {
		// State is created fresh each time so callers can't
		// accidentally share a mutable singleton. Each session
		// owns its own copy.
		const a = createPrWorkflowState();
		const b = createPrWorkflowState();
		expect(a).not.toBe(b);
		a.active = true;
		expect(b.active).toBe(false);
	});
});
