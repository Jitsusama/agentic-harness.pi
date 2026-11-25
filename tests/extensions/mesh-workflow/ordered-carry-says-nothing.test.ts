/**
 * What an ordered carry says where something thrown says nothing of
 * why, as `new Error()` does: at each catch on its way, the words that
 * say so, never a blank after the colon.
 */

import { describe, expect, it } from "vitest";
import {
	createOrderedCarrying,
	type OrderedCarryHost,
} from "../../../extensions/mesh-workflow/ordered-carry.ts";

const ORDER = {
	to: "penelope",
	why: "its camera work needs the Mac",
	by: "WCJQSG",
};

const HELD = "it holds a lease";

/** Said for what was thrown that said nothing, as carrying's messageOf words it. */
const SILENT = "something was thrown that said nothing of why";

/** A thrown error that says nothing, which the linter won't let be written as `new Error()`. */
const silent = () => Object.assign(new Error("said"), { message: "" });

/** An idle session holding nothing, on a clock its looks move, with what each test changes. */
function session(over: Partial<OrderedCarryHost> & { busy?: boolean } = {}) {
	const told: string[] = [];
	const refused: string[] = [];
	let now = 0;
	const at = { idle: !(over.busy ?? false) };
	const { busy: _busy, ...host } = over;
	const ordering = createOrderedCarrying({
		idle: () => at.idle,
		abort: () => undefined,
		holds: async () => undefined,
		hold: () => ({ release: () => undefined, carried: () => undefined }),
		carry: async () => undefined,
		refuse: async (why) => {
			refused.push(why);
		},
		tell: (text) => told.push(text),
		close: () => undefined,
		carryOn: () => undefined,
		stopping: () => [],
		note: () => undefined,
		waitMs: 10_000,
		lookMs: 1_000,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
			await new Promise((done) => setImmediate(done));
		},
		...host,
	});
	return { ordering, told, refused, at };
}

describe("an ordered carry, where what was thrown says nothing", () => {
	it("refuses a carry whose work couldn't be carried, saying so", async () => {
		const one = session({
			carry: async () => {
				throw silent();
			},
		});

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual([`its work couldn't be carried: ${SILENT}`]);
	});

	it("refuses a carry whose look at what holds it threw, saying so", async () => {
		const one = session({
			holds: async () => {
				throw silent();
			},
		});

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual([`it couldn't be looked at: ${SILENT}`]);
	});

	it("says a refusal that couldn't be written, saying so", async () => {
		const one = session({
			holds: async () => HELD,
			refuse: async () => {
				throw silent();
			},
		});

		await one.ordering.order(ORDER);

		expect(one.told).toContain(
			`Its refusal couldn't be written where mycelium reads it, so the carry waits out its time there: ${SILENT}`,
		);
	});

	it("says a run it ended and couldn't take up, saying so", async () => {
		const one = session({
			busy: true,
			holds: async (runEnded) => (runEnded ? HELD : undefined),
			carryOn: () => {
				throw silent();
			},
		});

		const going = one.ordering.order(ORDER);
		await Promise.resolve();
		one.ordering.turnEnded();
		one.at.idle = true;
		await going;

		expect(one.told.at(-1)).toBe(
			`The run it ended couldn't be taken up: ${SILENT}`,
		);
	});
});
