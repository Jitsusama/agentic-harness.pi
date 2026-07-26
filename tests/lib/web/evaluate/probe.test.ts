/**
 * Building the source that runs a caller's code in the page.
 */

import { describe, expect, it } from "vitest";
import { evaluationSource } from "../../../../lib/web/evaluate/probe.js";

describe("the source a caller writes is the source that runs", () => {
	it("accepts a statement list, the way a console does", () => {
		// `scrollTo(0, 400); check()` used to come back as
		// "SyntaxError: Unexpected token ';'", which reads as the
		// caller's mistake rather than as our wrapper refusing to
		// hold more than one expression.
		const source = evaluationSource("window.scrollTo(0,400); 'done'");

		expect(source).toContain("() => { window.scrollTo(0,400); 'done' }");
	});

	it("still parenthesizes a single expression", () => {
		// An object literal has to read as a value, not a block.
		expect(evaluationSource("({a:1})")).toContain("const value = (({a:1}));");
	});

	it("leaves a genuine syntax error for the page to report", () => {
		// Not our job to diagnose; the page's exception is better
		// than anything we could say, and it still has to arrive.
		expect(() => evaluationSource("const = ;")).not.toThrow();
	});
});
