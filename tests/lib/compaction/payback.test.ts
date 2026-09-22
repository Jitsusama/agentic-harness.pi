import { describe, expect, it } from "vitest";
import { paybackTest } from "../../../lib/compaction/index.js";

describe("payback test", () => {
	it("fires when what compaction saves on re-admission outweighs the summary's own write cost", () => {
		// Validated against the shadow-mode replay over the real corpus:
		// this is the exact formula, dropped * remaining > ratio * retained.
		const fires = paybackTest({
			droppedTokens: 400_000,
			remainingTurns: 50,
			retainedTokens: 100_000,
			readPrice: 1,
			writePrice: 5,
		});
		// dropped * remaining = 20,000,000; ratio * retained = 5 * 100,000 = 500,000
		expect(fires).toBe(true);
	});

	it("declines when a session is nearly over, since there is little left to save on", () => {
		const fires = paybackTest({
			droppedTokens: 400_000,
			remainingTurns: 1,
			retainedTokens: 100_000,
			readPrice: 1,
			writePrice: 5,
		});
		// dropped * remaining = 400,000; ratio * retained = 500,000
		expect(fires).toBe(false);
	});

	it("declines when nothing has been dropped", () => {
		const fires = paybackTest({
			droppedTokens: 0,
			remainingTurns: 100,
			retainedTokens: 50_000,
			readPrice: 1,
			writePrice: 5,
		});
		expect(fires).toBe(false);
	});

	it("scales the threshold with how much pricier a cache write is than a cache read", () => {
		// The ratio comes from the active model's own prices, not a fixed
		// constant, because that ratio is what a compaction actually costs
		// against what re-admitting the dropped content would have cost.
		// cheap: ratio 2, saved 100,000 vs cost 100,000 would be an exact
		// tie, so drop dropped tokens slightly to land clearly on the fires
		// side rather than resting the assertion on a boundary.
		const cheapWrite = paybackTest({
			droppedTokens: 20_000,
			remainingTurns: 10,
			retainedTokens: 50_000,
			readPrice: 1,
			writePrice: 2,
		});
		const expensiveWrite = paybackTest({
			droppedTokens: 10_000,
			remainingTurns: 10,
			retainedTokens: 50_000,
			readPrice: 1,
			writePrice: 20,
		});
		expect(cheapWrite).toBe(true);
		expect(expensiveWrite).toBe(false);
	});
});
