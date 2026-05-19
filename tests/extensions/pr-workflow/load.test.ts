import { describe, expect, it } from "vitest";
import { loadPr } from "../../../extensions/pr-workflow/load.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";

describe("loadPr", () => {
	it("attaches a PR parsed from a full GitHub URL", () => {
		// A pasted URL is the most common load input. The function
		// should pull owner / repo / number out and engage the
		// workflow.
		const state = createPrWorkflowState();
		const result = loadPr(state, {
			input: "https://github.com/Jitsusama/agentic-harness.pi/pull/180",
			now: () => new Date("2026-05-18T01:00:00Z"),
		});

		expect(result.ok).toBe(true);
		expect(state.active).toBe(true);
		expect(state.pr).not.toBeNull();
		expect(state.pr?.reference).toEqual({
			owner: "Jitsusama",
			repo: "agentic-harness.pi",
			number: 180,
		});
		expect(state.pr?.loadedAt).toBe("2026-05-18T01:00:00.000Z");
	});

	it("attaches a PR parsed from owner/repo#number short form", () => {
		// The short form is the agent's preferred shape when it
		// already knows the repo. It should resolve without any
		// extra context.
		const state = createPrWorkflowState();
		const result = loadPr(state, {
			input: "Shopify/world#12345",
			now: () => new Date("2026-05-18T01:00:00Z"),
		});

		expect(result.ok).toBe(true);
		expect(state.pr?.reference).toEqual({
			owner: "Shopify",
			repo: "world",
			number: 12345,
		});
	});

	it("attaches a PR parsed from a bare number when defaults are supplied", () => {
		// Inside a checkout the user often just types "#42". Without
		// repo defaults we can't resolve it; with them, we can.
		const state = createPrWorkflowState();
		const result = loadPr(state, {
			input: "#42",
			defaultRepo: { owner: "Jitsusama", repo: "neovim.pi" },
			now: () => new Date("2026-05-18T01:00:00Z"),
		});

		expect(result.ok).toBe(true);
		expect(state.pr?.reference).toEqual({
			owner: "Jitsusama",
			repo: "neovim.pi",
			number: 42,
		});
	});

	it("rejects a bare number when no defaults are supplied", () => {
		// "#42" alone is ambiguous; we surface the ambiguity rather
		// than guessing.
		const state = createPrWorkflowState();
		const result = loadPr(state, {
			input: "42",
			now: () => new Date("2026-05-18T01:00:00Z"),
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/owner|repo|short form|URL/i);
		}
		expect(state.active).toBe(false);
		expect(state.pr).toBeNull();
	});

	it("rejects an unparseable reference and leaves state untouched", () => {
		// Garbage input must not partially engage the workflow.
		const state = createPrWorkflowState();
		const result = loadPr(state, {
			input: "not-a-pr",
			now: () => new Date("2026-05-18T01:00:00Z"),
		});

		expect(result.ok).toBe(false);
		expect(state.active).toBe(false);
		expect(state.pr).toBeNull();
	});

	it("replaces an already-loaded PR with the new one", () => {
		// Swapping PRs mid-session is normal. The latest load wins;
		// state.pr always reflects the current focus.
		const state = createPrWorkflowState();
		loadPr(state, {
			input: "Shopify/world#1",
			now: () => new Date("2026-05-18T01:00:00Z"),
		});
		const result = loadPr(state, {
			input: "Shopify/world#2",
			now: () => new Date("2026-05-18T02:00:00Z"),
		});

		expect(result.ok).toBe(true);
		expect(state.pr?.reference.number).toBe(2);
		expect(state.pr?.loadedAt).toBe("2026-05-18T02:00:00.000Z");
	});
});
