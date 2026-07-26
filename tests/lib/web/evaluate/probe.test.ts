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

		expect(source).toContain("window.scrollTo(0,400);");
		expect(source).toContain("'done'");
	});

	it("answers a statement list with its last expression", () => {
		// A console shows the completion value of what you typed, so
		// `var a = 1; a + 41` is 42. Run as a plain function body it
		// answered undefined, and people paste snippets ending in the
		// thing they want to see: the value was simply lost, and the
		// only clue was having to retype it with a return.
		expect(evaluationSource("var a = 1; a + 41")).toContain("return (a + 41);");
	});

	it("leaves an explicit return alone", () => {
		const source = evaluationSource("var b = 2; return b + 40");
		expect(source).toContain("return b + 40");
		expect(source).not.toContain("return (return");
	});

	it("ignores a semicolon inside a string or a bracket", () => {
		// Splitting on any semicolon would cut these in half and the
		// rewrite would not compile, losing the completion value for
		// no reason.
		expect(evaluationSource("var s = 'a;b'; s.length")).toContain(
			"return (s.length);",
		);
		expect(evaluationSource("var f = (a) => { return 1; }; f(0)")).toContain(
			"return (f(0));",
		);
	});

	it("tolerates a trailing semicolon", () => {
		expect(evaluationSource("var a = 1; a + 1;")).toContain("return (a + 1);");
	});

	it("does not try to return a declaration", () => {
		// `return (var x = 1)` is a syntax error, so the rewrite has to
		// stand down rather than break a call that worked before.
		const source = evaluationSource("doThing(); var x = 1;");
		expect(source).not.toContain("return (var");
		expect(source).toContain("var x = 1;");
	});

	it("does not try to return a block", () => {
		const source = evaluationSource(
			"var n = 0; for (const x of [1,2]) { n += x }",
		);
		expect(source).not.toContain("return (for");
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
