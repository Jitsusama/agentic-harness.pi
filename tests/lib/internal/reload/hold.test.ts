import { afterEach, describe, expect, it } from "vitest";
import {
	createReloadHold,
	HOLD_FOR_RELOAD_MS,
	MOMENT_GAP_MS,
} from "../../../../lib/internal/reload/hold.ts";
import { reloadSlot } from "../../../../lib/internal/reload/slot.ts";

afterEach(() => {
	const slot = reloadSlot();
	slot.request = undefined;
	slot.reloading = undefined;
});

/** A hold read on a clock the test moves, every second as the outbox looks. */
function clocked() {
	let at = 1_000_000;
	const hold = createReloadHold(() => at);
	return {
		hold,
		later(ms: number) {
			at += ms;
			return hold();
		},
	};
}

describe("a delivery held for a waiting reload", () => {
	it("goes at once when no reload is asked for", () => {
		expect(clocked().hold()).toBe(false);
	});

	it("waits while a reload is asked for, then goes once its moment has passed", () => {
		reloadSlot().request = { reason: "the install moved", by: "self" };
		const { hold, later } = clocked();

		expect(hold()).toBe(true);
		let held = 0;
		while (later(1_000)) held += 1;

		expect(held).toBe(HOLD_FOR_RELOAD_MS / 1_000 - 1);
	});

	it("goes once the reload is under way, which carries it over", () => {
		const slot = reloadSlot();
		slot.request = { reason: "asked", by: "agent" };
		const { hold } = clocked();
		expect(hold()).toBe(true);

		slot.reloading = true;

		expect(hold()).toBe(false);
	});

	it("takes each free moment afresh, so a long run never spends the hold", () => {
		reloadSlot().request = { reason: "the install moved", by: "self" };
		const { hold, later } = clocked();
		expect(hold()).toBe(true);
		let spent = false;
		while (!spent) spent = !later(1_000);

		// The outbox stops asking while a run goes, here for 20 minutes.
		expect(later(20 * 60_000)).toBe(true);
		expect(later(MOMENT_GAP_MS)).toBe(true);
	});
});
