import type { Loop } from "@jitsusama/agentic-harness.core/tdd";
import { describe, expect, it } from "vitest";
import {
	createTddState,
	type TddState,
} from "../../../extensions/tdd-workflow/state.ts";
import {
	buildTddContext,
	remindedIn,
} from "../../../extensions/tdd-workflow/transitions.ts";

function stateWith(overrides: Partial<Loop> = {}, reminded = false): TddState {
	return {
		reminded,
		loop: {
			phase: "plan",
			assertionFailure: false,
			behaviour: "rejects an empty cart",
			iteration: 1,
			...overrides,
		},
	};
}

describe("buildTddContext", () => {
	it("reports the iteration, phase and behaviour, not the discipline", () => {
		const context = buildTddContext(
			stateWith({ phase: "write", iteration: 2 }),
		);
		expect(context).toBeDefined();
		const content = context?.message.content ?? "";
		expect(content).toContain("write");
		expect(content).toContain("2");
		expect(content).toContain("rejects an empty cart");
		expect(content).not.toContain("exported surface");
		expect(context?.message.customType).toBe("tdd-workflow-context");
		expect(context?.message.display).toBe(false);
	});

	it("stays silent when no loop is active", () => {
		expect(buildTddContext(createTddState())).toBeUndefined();
	});

	it("stays silent while resting between loops", () => {
		expect(buildTddContext(stateWith({ phase: "idle" }))).toBeUndefined();
	});
});

describe("closing a loop", () => {
	it("says once that the reminders no longer apply when the loop goes idle", () => {
		const state = stateWith({ phase: "red" });
		expect(buildTddContext(state)?.message.content).toContain("red");
		state.loop = { ...state.loop, phase: "idle" };
		const closing = buildTddContext(state);
		expect(closing?.message.customType).toBe("tdd-workflow-context");
		expect(closing?.message.content).toContain("no longer apply");
		expect(buildTddContext(state)).toBeUndefined();
	});

	it("reminds again when the next loop starts", () => {
		const state = stateWith({ phase: "idle" }, true);
		buildTddContext(state);
		state.loop = { ...state.loop, phase: "plan" };
		expect(buildTddContext(state)?.message.content).toContain("plan");
	});
});

describe("remindedIn", () => {
	const reminder = {
		type: "custom_message",
		customType: "tdd-workflow-context",
		content: "TDD loop 1, phase red",
	};
	const other = { type: "custom_message", customType: "other", content: "x" };

	it("is true when the last TDD message is a live reminder", () => {
		expect(remindedIn([reminder, other])).toBe(true);
	});

	it("is false once a closing message followed it", () => {
		const idle = stateWith({ phase: "idle" }, true);
		const closing = {
			type: "custom_message",
			...buildTddContext(idle)?.message,
		};
		expect(remindedIn([reminder, closing])).toBe(false);
	});

	it("is false when the conversation holds no TDD message", () => {
		expect(remindedIn([other])).toBe(false);
	});
});
