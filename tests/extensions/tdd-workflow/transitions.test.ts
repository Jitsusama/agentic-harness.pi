import type { ContextEvent } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { LoopState } from "../../../extensions/tdd-workflow/machine.js";
import { createTddState } from "../../../extensions/tdd-workflow/state.js";
import {
	buildTddContext,
	tddContextFilter,
} from "../../../extensions/tdd-workflow/transitions.js";

// AgentMessage is opaque to consumers, so test fixtures are cast
// to a context event through the structural shape the filter reads.
function contextEvent(messages: Array<Record<string, unknown>>): ContextEvent {
	return { type: "context", messages } as unknown as ContextEvent;
}

function stateWith(overrides: Partial<LoopState> = {}): { loop: LoopState } {
	return {
		loop: {
			phase: "plan",
			redVerified: false,
			behaviour: "rejects an empty cart",
			loop: 1,
			engaged: true,
			...overrides,
		},
	};
}

describe("buildTddContext", () => {
	it("injects the phase, the behaviour and the standing discipline", () => {
		const context = buildTddContext(stateWith({ phase: "write" }));
		expect(context).toBeDefined();
		const content = context?.message.content ?? "";
		expect(content).toContain("write");
		expect(content).toContain("rejects an empty cart");
		expect(content).toContain("exported surface");
		expect(context?.message.customType).toBe("tdd-workflow-context");
		expect(context?.message.display).toBe(false);
	});

	it("stays silent when no loop has been engaged", () => {
		expect(buildTddContext(createTddState())).toBeUndefined();
	});

	it("stays silent while resting between loops", () => {
		expect(buildTddContext(stateWith({ phase: "idle" }))).toBeUndefined();
	});
});

describe("tddContextFilter", () => {
	it("leaves the context in place while a loop is active", async () => {
		const filter = tddContextFilter(stateWith({ phase: "red" }));
		const event = contextEvent([
			{ customType: "tdd-workflow-context", content: "x" },
			{ customType: "other" },
		]);
		expect(await filter(event)).toBeUndefined();
	});

	it("strips stale context once the loop is no longer active", async () => {
		const filter = tddContextFilter(stateWith({ phase: "idle" }));
		const event = contextEvent([
			{ customType: "tdd-workflow-context", content: "x" },
			{ customType: "other" },
		]);
		const result = await filter(event);
		expect(result?.messages).toEqual([{ customType: "other" }]);
	});
});
