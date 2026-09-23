import { describe, expect, it } from "vitest";
import {
	INITIAL_DEAD_HORSE,
	isDeadHorse,
	observeVerify,
} from "../../../lib/control/index.ts";

describe("counting consecutive verify failures", () => {
	it("starts at zero", () => {
		expect(INITIAL_DEAD_HORSE).toEqual({ consecutiveFailures: 0 });
	});

	it("counts up on a failure", () => {
		const state = observeVerify(INITIAL_DEAD_HORSE, { passed: false });
		expect(state.consecutiveFailures).toBe(1);
	});

	it("resets to zero the moment one passes", () => {
		let state = INITIAL_DEAD_HORSE;
		state = observeVerify(state, { passed: false });
		state = observeVerify(state, { passed: false });
		state = observeVerify(state, { passed: true });
		expect(state.consecutiveFailures).toBe(0);
	});

	it("keeps counting across repeated failures with no pass between them", () => {
		let state = INITIAL_DEAD_HORSE;
		for (let i = 0; i < 4; i++) state = observeVerify(state, { passed: false });
		expect(state.consecutiveFailures).toBe(4);
	});
});

describe("deciding whether the run is a dead horse", () => {
	it("is not a dead horse below the threshold", () => {
		expect(isDeadHorse({ consecutiveFailures: 2 }, 3)).toBe(false);
	});

	it("is a dead horse at or past the threshold", () => {
		expect(isDeadHorse({ consecutiveFailures: 3 }, 3)).toBe(true);
		expect(isDeadHorse({ consecutiveFailures: 5 }, 3)).toBe(true);
	});
});
