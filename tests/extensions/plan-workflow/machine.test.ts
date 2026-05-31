import { describe, expect, it } from "vitest";
import {
	initialState,
	type Stage,
	transition,
} from "../../../extensions/plan-workflow/machine.js";

function at(stage: Stage) {
	return { stage };
}

describe("initialState", () => {
	it("rests at idle with no plan in play", () => {
		expect(initialState()).toEqual({ stage: "idle" });
	});
});

describe("transition: think", () => {
	it("opens a planning effort from idle when a note frames it", () => {
		const result = transition(at("idle"), {
			action: "think",
			note: "redesign the plan workflow",
		});
		expect(result).toEqual({ ok: true, state: { stage: "think" } });
	});

	it("refuses to start thinking without a note", () => {
		const result = transition(at("idle"), { action: "think" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.guidance).toMatch(/note|about|why/i);
	});

	it("replans from build back to think with a note on what changed", () => {
		const result = transition(at("build"), {
			action: "think",
			note: "the storage approach doesn't survive a reaped worktree",
		});
		expect(result).toEqual({ ok: true, state: { stage: "think" } });
	});

	it("replans from plan back to think", () => {
		const result = transition(at("plan"), {
			action: "think",
			note: "drafting showed the stages are wrong",
		});
		expect(result).toEqual({ ok: true, state: { stage: "think" } });
	});

	it("refuses to re-enter think when already thinking", () => {
		const result = transition(at("think"), {
			action: "think",
			note: "anything",
		});
		expect(result.ok).toBe(false);
	});

	it("refuses to think from a terminal stage", () => {
		expect(transition(at("concluded"), { action: "think", note: "x" }).ok).toBe(
			false,
		);
		expect(transition(at("retired"), { action: "think", note: "x" }).ok).toBe(
			false,
		);
	});
});

describe("transition: draft", () => {
	it("moves from think to plan to draft the document", () => {
		expect(transition(at("think"), { action: "draft" })).toEqual({
			ok: true,
			state: { stage: "plan" },
		});
	});

	it("refuses to draft from anywhere but think", () => {
		expect(transition(at("idle"), { action: "draft" }).ok).toBe(false);
		expect(transition(at("build"), { action: "draft" }).ok).toBe(false);
		expect(transition(at("plan"), { action: "draft" }).ok).toBe(false);
	});
});

describe("transition: build", () => {
	it("moves from plan to build once the plan is drafted", () => {
		expect(transition(at("plan"), { action: "build" })).toEqual({
			ok: true,
			state: { stage: "build" },
		});
	});

	it("refuses to build straight from think, without a drafted plan", () => {
		const result = transition(at("think"), { action: "build" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.guidance).toMatch(/draft|plan/i);
	});
});

describe("transition: conclude", () => {
	it("closes an active plan to concluded from any working stage", () => {
		for (const s of ["think", "plan", "build"] as const) {
			expect(transition(at(s), { action: "conclude" })).toEqual({
				ok: true,
				state: { stage: "concluded" },
			});
		}
	});

	it("refuses to conclude when no plan is active", () => {
		expect(transition(at("idle"), { action: "conclude" }).ok).toBe(false);
		expect(transition(at("concluded"), { action: "conclude" }).ok).toBe(false);
	});
});

describe("transition: retire", () => {
	it("retires an active plan with a reason", () => {
		const result = transition(at("build"), {
			action: "retire",
			reason: "superseded by a different approach",
		});
		expect(result).toEqual({ ok: true, state: { stage: "retired" } });
	});

	it("refuses to retire without a reason", () => {
		const result = transition(at("think"), { action: "retire" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.guidance).toMatch(/reason/i);
	});

	it("refuses to retire when no plan is active", () => {
		expect(transition(at("idle"), { action: "retire", reason: "x" }).ok).toBe(
			false,
		);
	});
});

describe("transition: unknown action", () => {
	it("refuses with guidance instead of throwing", () => {
		const result = transition(at("idle"), {
			action: "frobnicate" as unknown as "think",
		});
		expect(result.ok).toBe(false);
	});
});
