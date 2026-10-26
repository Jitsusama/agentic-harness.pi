/**
 * A record is an object whose keys can be read by name: not null, not a
 * primitive, and not an array, since every caller reads named fields.
 */

import { describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";

describe("isRecord", () => {
	it("takes an object, empty or not", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ usage: { input: 1 } })).toBe(true);
	});

	it("refuses an array, which has no named fields", () => {
		expect(isRecord([])).toBe(false);
		expect(isRecord([{ usage: 1 }])).toBe(false);
	});

	it("refuses null, undefined and every primitive", () => {
		for (const value of [null, undefined, 0, "", "text", true]) {
			expect(isRecord(value), String(value)).toBe(false);
		}
	});
});
