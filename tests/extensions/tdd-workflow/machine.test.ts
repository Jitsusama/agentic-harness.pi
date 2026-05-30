import { describe, expect, it } from "vitest";
import {
	initialState,
	type LoopState,
	transition,
} from "../../../extensions/tdd-workflow/machine.js";

/** An active loop in a given phase, for testing one transition in isolation. */
function loop(overrides: Partial<LoopState> = {}): LoopState {
	return {
		phase: "plan",
		redVerified: false,
		behaviour: "rejects an empty cart",
		loop: 1,
		engaged: true,
		...overrides,
	};
}

/** The resting state after a loop closes: idle, but still engaged this session. */
function rested(loopCount = 1): LoopState {
	return {
		phase: "idle",
		redVerified: false,
		behaviour: null,
		loop: loopCount,
		engaged: true,
	};
}

describe("initialState", () => {
	it("starts idle, not engaged, at loop zero", () => {
		expect(initialState()).toEqual({
			phase: "idle",
			redVerified: false,
			behaviour: null,
			loop: 0,
			engaged: false,
		});
	});
});

describe("transition: start", () => {
	it("opens a loop in plan from idle when a behaviour is named", () => {
		const result = transition(initialState(), {
			action: "start",
			behaviour: "rejects an empty cart",
		});

		expect(result).toEqual({
			ok: true,
			state: {
				phase: "plan",
				redVerified: false,
				behaviour: "rejects an empty cart",
				loop: 1,
				engaged: true,
			},
		});
	});

	it("refuses to start without a behaviour, leaving state untouched", () => {
		const state = initialState();

		const result = transition(state, { action: "start" });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.guidance).toMatch(/behaviour|increment/i);
		}
		expect(state).toEqual(initialState());
	});

	it("refuses to start a new loop while one is already active", () => {
		const result = transition(loop({ phase: "red" }), {
			action: "start",
			behaviour: "some other behaviour",
		});

		expect(result.ok).toBe(false);
	});
});

describe("transition: write", () => {
	it("moves from plan to write when the exported surface is named", () => {
		const result = transition(loop({ phase: "plan" }), {
			action: "write",
			interface: "Cart#checkout raises EmptyCartError",
		});

		expect(result).toEqual({ ok: true, state: loop({ phase: "write" }) });
	});

	it("refuses to write without naming the exported surface", () => {
		const result = transition(loop({ phase: "plan" }), { action: "write" });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.guidance).toMatch(/exported surface|interface/i);
		}
	});

	it("refuses to write from any phase but plan", () => {
		const result = transition(loop({ phase: "red" }), {
			action: "write",
			interface: "Cart#checkout raises EmptyCartError",
		});

		expect(result.ok).toBe(false);
	});
});

describe("transition: red", () => {
	it("enters red unverified when the failure isn't a clean assertion", () => {
		const result = transition(loop({ phase: "write" }), {
			action: "red",
			failure: "undefined method `checkout' for Cart",
			failureKind: "other",
		});

		expect(result).toEqual({
			ok: true,
			state: loop({ phase: "red", redVerified: false }),
		});
	});

	it("enters red verified when a real assertion failure is attested", () => {
		const result = transition(loop({ phase: "write" }), {
			action: "red",
			failure: "expected EmptyCartError, got nil",
			failureKind: "assertion",
		});

		expect(result).toEqual({
			ok: true,
			state: loop({ phase: "red", redVerified: true }),
		});
	});

	it("upgrades an unverified red to verified on a later assertion failure", () => {
		const result = transition(loop({ phase: "red", redVerified: false }), {
			action: "red",
			failure: "expected EmptyCartError, got nil",
			failureKind: "assertion",
		});

		expect(result).toEqual({
			ok: true,
			state: loop({ phase: "red", redVerified: true }),
		});
	});

	it("refuses to enter red without a reported failure", () => {
		const result = transition(loop({ phase: "write" }), {
			action: "red",
			failureKind: "assertion",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.guidance).toMatch(/failure/i);
		}
	});

	it("refuses to enter red from anywhere but write or red", () => {
		const result = transition(loop({ phase: "plan" }), {
			action: "red",
			failure: "expected EmptyCartError, got nil",
			failureKind: "assertion",
		});

		expect(result.ok).toBe(false);
	});
});

describe("transition: green", () => {
	it("passes from a verified red when the passing result is reported", () => {
		const result = transition(loop({ phase: "red", redVerified: true }), {
			action: "green",
			pass: "1 example, 0 failures",
		});

		expect(result).toEqual({ ok: true, state: loop({ phase: "green" }) });
	});

	it("refuses to pass from an unverified red", () => {
		const result = transition(loop({ phase: "red", redVerified: false }), {
			action: "green",
			pass: "1 example, 0 failures",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.guidance).toMatch(/real red|assertion/i);
		}
	});

	it("refuses to pass without reporting the passing result", () => {
		const result = transition(loop({ phase: "red", redVerified: true }), {
			action: "green",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.guidance).toMatch(/passing result/i);
		}
	});
});

describe("transition: refactor", () => {
	it("moves from green to refactor without extra justification", () => {
		const result = transition(loop({ phase: "green" }), { action: "refactor" });

		expect(result).toEqual({ ok: true, state: loop({ phase: "refactor" }) });
	});

	it("refuses to refactor from any phase but green", () => {
		const result = transition(loop({ phase: "write" }), { action: "refactor" });

		expect(result.ok).toBe(false);
	});
});

describe("transition: done", () => {
	it("closes the loop to idle when a design reflection is given", () => {
		const result = transition(loop({ phase: "refactor" }), {
			action: "done",
			reflection: "Pulled the guard into the cart; the caller stops branching.",
		});

		expect(result).toEqual({ ok: true, state: rested(1) });
	});

	it("refuses to close without a design reflection", () => {
		const result = transition(loop({ phase: "refactor" }), { action: "done" });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.guidance).toMatch(/internal and external|reconsider/i);
		}
	});

	it("refuses to close from any phase but refactor", () => {
		const result = transition(loop({ phase: "green" }), {
			action: "done",
			reflection: "anything",
		});

		expect(result.ok).toBe(false);
	});
});

describe("transition: abandon", () => {
	it("drops an active loop back to idle with a reason", () => {
		const result = transition(loop({ phase: "red", redVerified: true }), {
			action: "abandon",
			reason: "The increment was too big, so I'm splitting it.",
		});

		expect(result).toEqual({ ok: true, state: rested(1) });
	});

	it("refuses to abandon without a reason", () => {
		const result = transition(loop({ phase: "red" }), { action: "abandon" });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.guidance).toMatch(/reason/i);
		}
	});

	it("refuses to abandon when no loop is in play", () => {
		const result = transition(initialState(), {
			action: "abandon",
			reason: "x",
		});

		expect(result.ok).toBe(false);
	});
});
