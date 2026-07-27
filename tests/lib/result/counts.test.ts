import { describe, expect, it } from "vitest";
import { count } from "../../../lib/result/counts.js";

describe("writing a count into a citation", () => {
	it("groups thousands with commas", () => {
		expect(count(0)).toBe("0");
		expect(count(999)).toBe("999");
		expect(count(1_000)).toBe("1,000");
		expect(count(18_004)).toBe("18,004");
		expect(count(1_234_567)).toBe("1,234,567");
	});

	it("says the same thing wherever it runs", () => {
		// The reason this function exists. `toLocaleString` answers with
		// the machine's convention, so the same citation reads 18,004
		// here and 18.004 on a runner configured for German, where a
		// model has every reason to read it as eighteen and a bit. The
		// tests that pin these strings would fail there too, which is
		// the kind of failure that looks like a bug in the code it
		// breaks.
		//
		// Asserted against an explicit foreign locale rather than by
		// setting one, because Node takes its default from the
		// operating system and LANG does not move it on macOS: a test
		// that set the variable and passed would be proving nothing.
		expect((18_004).toLocaleString("de-DE")).toBe("18.004");
		expect(count(18_004)).toBe("18,004");
	});
});
