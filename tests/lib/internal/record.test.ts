/**
 * A record is an object whose keys can be read by name: not null, not a
 * primitive, and not an array, since every caller reads named fields.
 */

import { describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";

describe("isRecord", () => {
	it("takes an object, empty or not", () => {
		expect(isRecord({}), "an empty object is a record").toBe(true);
		expect(
			isRecord({ usage: { input: 1 } }),
			"an object with a field is a record",
		).toBe(true);
	});

	it("refuses an array, which has no named fields", () => {
		expect(isRecord([]), "an empty array is no record").toBe(false);
		expect(
			isRecord([{ usage: 1 }]),
			"an array holding a record is no record",
		).toBe(false);
	});

	it("refuses null, undefined and every primitive", () => {
		for (const value of [null, undefined, 0, "", "text", true]) {
			expect(isRecord(value), String(value)).toBe(false);
		}
	});
});
