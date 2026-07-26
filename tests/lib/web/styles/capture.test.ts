import { describe, expect, it } from "vitest";
import { asCall } from "../../../../lib/web/styles/index.js";

describe("asCall", () => {
	it("calls the source with no arguments", () => {
		expect(asCall("(function () { return 1; })")).toBe(
			"((function () { return 1; }))()",
		);
	});

	it("passes an argument as a literal the page can read", () => {
		expect(asCall("(f)", ["a", "b"])).toBe('((f))(["a","b"])');
	});

	it("separates several arguments", () => {
		expect(asCall("(f)", 1, "two")).toBe('((f))(1, "two")');
	});

	it("escapes a string that would otherwise end the call", () => {
		// A value carrying a quote must not be able to close the
		// expression and run something else.
		expect(asCall("(f)", '"); alert(1); ("')).toBe(
			'((f))("\\"); alert(1); (\\"")',
		);
	});
});
