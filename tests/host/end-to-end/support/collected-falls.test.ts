/**
 * A quiet child's collection is judged by the falls its own line says,
 * against HEAP_FALL_MB and PSS_FALL_MB. The real-engine case that judges
 * them runs only in test:host, so a focused run skips it; these replay
 * recorded and made lines through the parse, so a parse that passes a
 * collection freeing nothing, or fails a real one, fails here at once.
 */

import { describe, expect, it } from "vitest";
import {
	collectedFalls,
	HEAP_FALL_MB,
	PSS_FALL_MB,
} from "./collected-falls.ts";

/** What a collection's line says after its heap, as the engine writes it. */
const REST =
	"(old 80 of 90 MB, code 20 of 40 MB), outside it 30 MB to 28 MB, of which array buffers 4 MB to 3 MB, with 0 conversations waiting on the model";

describe("a quiet collection's falls", () => {
	it("pass the collection of 27 November, whose heap's size fell though little of it was used", () => {
		const falls = collectedFalls(
			`Collected while quiet in 812 ms, Pss 695 MB to 228 MB, heap 132 of 541 MB to 115 of 139 MB ${REST}`,
		);
		expect(falls).toEqual({
			words: "132 of 541 MB to 115 of 139 MB",
			heap: 402,
			pss: 467,
		});
		expect(falls.heap, "MB off the heap").toBeGreaterThanOrEqual(HEAP_FALL_MB);
		expect(falls.pss, "MB off the Pss").toBeGreaterThanOrEqual(PSS_FALL_MB);
	});

	it("fail a scavenge, which took 29 MB off what the heap used and left its size", () => {
		const falls = collectedFalls(
			`Collected while quiet in 40 ms, Pss 560 MB to 548 MB, heap 240 of 300 MB to 211 of 300 MB ${REST}`,
		);
		expect(falls.heap, "MB off the heap").toBe(29);
		expect(falls.heap, "MB off the heap").toBeLessThan(HEAP_FALL_MB);
		expect(falls.pss, "MB off the Pss").toBeLessThan(PSS_FALL_MB);
	});

	it("fail a collection that freed nothing", () => {
		const falls = collectedFalls(
			`Collected while quiet in 5 ms, Pss 560 MB to 560 MB, heap 240 of 300 MB to 240 of 300 MB ${REST}`,
		);
		expect(falls).toEqual({
			words: "240 of 300 MB to 240 of 300 MB",
			heap: 0,
			pss: 0,
		});
	});

	it("still read the heap where the Pss went unread, and no Pss fall", () => {
		expect(
			collectedFalls(
				`Collected while quiet in 812 ms, Pss unread, heap 132 of 541 MB to 115 of 139 MB ${REST}`,
			),
		).toEqual({ words: "132 of 541 MB to 115 of 139 MB", heap: 402 });
	});

	it("read as unread where the line says no heap", () => {
		expect(
			collectedFalls(
				"Collected while quiet in 1240 ms, Pss 695 MB to 228 MB, with 2 conversations waiting on the model; the loop held 1.2 s for it",
			),
		).toEqual({ words: "unread" });
	});
});
