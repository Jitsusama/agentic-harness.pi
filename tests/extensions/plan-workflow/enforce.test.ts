import { describe, expect, it } from "vitest";
import { enforcePlan } from "../../../extensions/plan-workflow/enforce.js";
import {
	createPlanState,
	type PlanState,
} from "../../../extensions/plan-workflow/state.js";

const CWD = "/repo";

function state(over: Partial<PlanState> = {}): PlanState {
	return { ...createPlanState(), ...over };
}

describe("enforcePlan", () => {
	it("does not interfere when no plan is active", () => {
		expect(
			enforcePlan(state({ stage: "idle" }), "write", { path: "src/a.ts" }, CWD),
		).toBeUndefined();
	});

	it("blocks a code write while thinking", () => {
		const result = enforcePlan(
			state({ stage: "think", planPath: "/repo/.pi/plans/p.md" }),
			"write",
			{ path: "src/a.ts" },
			CWD,
		);
		expect(result?.block).toBe(true);
	});

	it("allows writing the active plan document while planning", () => {
		expect(
			enforcePlan(
				state({ stage: "plan", planPath: "/repo/.pi/plans/p.md" }),
				"write",
				{ path: ".pi/plans/p.md" },
				CWD,
			),
		).toBeUndefined();
	});

	it("blocks edits to other files while planning", () => {
		const result = enforcePlan(
			state({ stage: "plan", planPath: "/repo/.pi/plans/p.md" }),
			"edit",
			{ path: "src/b.ts" },
			CWD,
		);
		expect(result?.block).toBe(true);
	});

	it("blocks git-mutating bash while planning", () => {
		const result = enforcePlan(
			state({ stage: "think" }),
			"bash",
			{ command: "git commit -m x" },
			CWD,
		);
		expect(result?.block).toBe(true);
	});

	it("lets everything through once building", () => {
		expect(
			enforcePlan(
				state({ stage: "build" }),
				"write",
				{ path: "src/a.ts" },
				CWD,
			),
		).toBeUndefined();
		expect(
			enforcePlan(
				state({ stage: "build" }),
				"bash",
				{ command: "git commit -m x" },
				CWD,
			),
		).toBeUndefined();
	});
});
