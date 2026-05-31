import type { ContextEvent } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	createPlanState,
	type PlanState,
} from "../../../extensions/plan-workflow/state.js";
import {
	buildPlanContext,
	planContextFilter,
} from "../../../extensions/plan-workflow/transitions.js";

function stateWith(over: Partial<PlanState> = {}): PlanState {
	return { ...createPlanState(), ...over };
}

function contextEvent(messages: Array<Record<string, unknown>>): ContextEvent {
	return { type: "context", messages } as unknown as ContextEvent;
}

describe("buildPlanContext", () => {
	it("is silent when no plan is active", () => {
		expect(buildPlanContext(createPlanState())).toBeUndefined();
		expect(buildPlanContext(stateWith({ stage: "concluded" }))).toBeUndefined();
	});

	it("reports the stage, plan and progress as plain facts", () => {
		const ctx = buildPlanContext(
			stateWith({
				stage: "build",
				planId: "PLAN-20260530-a3f",
				title: "Workflow Redesign",
				done: 1,
				total: 3,
				planPath: "/repo/.pi/plans/p.md",
			}),
		);
		const content = ctx?.message.content ?? "";
		expect(content).toContain("build");
		expect(content).toContain("PLAN-20260530-a3f");
		expect(content).toContain("1/3");
		expect(content).toContain("/repo/.pi/plans/p.md");
		expect(ctx?.message.customType).toBe("plan-workflow-context");
		expect(ctx?.message.display).toBe(false);
	});
});

describe("planContextFilter", () => {
	it("keeps the context while a plan is active", async () => {
		const filter = planContextFilter(stateWith({ stage: "think" }));
		const event = contextEvent([
			{ customType: "plan-workflow-context" },
			{ customType: "other" },
		]);
		expect(await filter(event)).toBeUndefined();
	});

	it("strips the stale context once the plan is no longer active", async () => {
		const filter = planContextFilter(stateWith({ stage: "idle" }));
		const event = contextEvent([
			{ customType: "plan-workflow-context" },
			{ customType: "other" },
		]);
		const result = await filter(event);
		expect(result?.messages).toEqual([{ customType: "other" }]);
	});
});
