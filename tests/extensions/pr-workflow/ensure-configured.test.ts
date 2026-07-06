import { describe, expect, it } from "vitest";
import type { PrWorkflowConfigLoadResult } from "../../../extensions/pr-workflow/config.js";
import { ensureCouncilConfigured } from "../../../extensions/pr-workflow/ensure-configured.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";

// The council and judge used to have to be configured by
// hand every session before a review would run. When a
// config file supplies defaults, ensureCouncilConfigured
// fills an unset roster and judge from it at point of use,
// so the review just runs. It only errors when the config
// itself cannot supply the missing piece.

const REVIEWER = { id: "alpha", model: "anthropic/x" };
const JUDGE = { id: "judge", model: "anthropic/y" };

function configWith(defaults: {
	reviewers?: { id: string; model?: string }[];
	judge?: { id: string; model?: string };
}): () => Promise<PrWorkflowConfigLoadResult> {
	return async () => ({
		ok: true,
		config: { path: "/cfg.json", defaults },
	});
}

describe("ensureCouncilConfigured", () => {
	it("hydrates an unset roster and judge from config defaults", async () => {
		const state = createPrWorkflowState();
		const result = await ensureCouncilConfigured(
			state,
			configWith({ reviewers: [REVIEWER], judge: JUDGE }),
		);
		expect(result.ok).toBe(true);
		expect(state.council.roster.map((r) => r.id)).toEqual(["alpha"]);
		expect(state.council.judge?.id).toBe("judge");
	});

	it("leaves an already-configured roster and judge untouched", async () => {
		const state = createPrWorkflowState();
		state.council.roster = [{ id: "existing", model: "m" }];
		state.council.judge = { id: "existing-judge", model: "m" };
		let loaded = false;
		const result = await ensureCouncilConfigured(state, async () => {
			loaded = true;
			return { ok: true, config: { path: "/cfg.json", defaults: {} } };
		});
		expect(result.ok).toBe(true);
		expect(loaded).toBe(false);
		expect(state.council.roster.map((r) => r.id)).toEqual(["existing"]);
		expect(state.council.judge?.id).toBe("existing-judge");
	});

	it("errors with a pointer when config is absent", async () => {
		const state = createPrWorkflowState();
		const result = await ensureCouncilConfigured(state, async () => ({
			ok: false,
			path: "/cfg.json",
			error: "No pr-workflow config found at /cfg.json.",
		}));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("council-config");
	});

	it("errors when config has a judge but no reviewers", async () => {
		const state = createPrWorkflowState();
		const result = await ensureCouncilConfigured(
			state,
			configWith({ judge: JUDGE }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("council-config");
	});

	it("errors when config has reviewers but no judge", async () => {
		const state = createPrWorkflowState();
		const result = await ensureCouncilConfigured(
			state,
			configWith({ reviewers: [REVIEWER] }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("judge-config");
	});
});
