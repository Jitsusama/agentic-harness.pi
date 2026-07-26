/**
 * Reading back an evaluation. The exception shapes are lifted
 * from live Runtime.evaluate calls, including the detail that
 * the details' own text says only "Uncaught".
 */

import { describe, expect, it } from "vitest";
import {
	describeThrow,
	type EvalOutcome,
	renderEvaluation,
} from "../../../../lib/web/evaluate/outcome.js";

describe("describeThrow", () => {
	it("takes the message from the exception, not the wrapper text", () => {
		// details.text is only ever "Uncaught", which tells nobody
		// anything they did not already know.
		const threw = describeThrow({
			text: "Uncaught",
			exception: {
				className: "TypeError",
				description:
					"TypeError: Cannot read properties of null (reading 'x')\n" +
					"    at <anonymous>:1:6",
			},
		});
		expect(threw.message).toBe(
			"TypeError: Cannot read properties of null (reading 'x')",
		);
		expect(threw.className).toBe("TypeError");
	});

	it("drops the stack the description carries, keeping the first line", () => {
		const threw = describeThrow({
			exception: { description: "Error: nope\n    at a\n    at b" },
		});
		expect(threw.message).not.toContain("at a");
	});

	it("knows a rejection from a throw", () => {
		expect(
			describeThrow({ text: "Uncaught (in promise) Error: nope" }).fromPromise,
		).toBe(true);
		expect(describeThrow({ text: "Uncaught" }).fromPromise).toBe(false);
	});

	it("reads the frames the protocol gave", () => {
		const threw = describeThrow({
			stackTrace: {
				callFrames: [
					{
						functionName: "save",
						url: "http://a/app.js",
						lineNumber: 41,
						columnNumber: 12,
					},
				],
			},
		});
		expect(threw.frames).toHaveLength(1);
		expect(threw.frames[0]?.functionName).toBe("save");
	});

	it("names an anonymous frame rather than leaving it blank", () => {
		const threw = describeThrow({
			stackTrace: { callFrames: [{ functionName: "", lineNumber: 0 }] },
		});
		expect(threw.frames[0]?.functionName).toBe("(anonymous)");
	});

	it("copes with a syntax error, which has no stack at all", () => {
		const threw = describeThrow({
			text: "Uncaught",
			exception: {
				className: "SyntaxError",
				description: "SyntaxError: Unexpected identifier 'is'",
			},
		});
		expect(threw.frames).toEqual([]);
		expect(threw.message).toContain("Unexpected identifier");
	});
});

describe("renderEvaluation", () => {
	const value = (
		over: Partial<{ type: string; value: unknown; clipped: boolean }>,
	) =>
		renderEvaluation({
			ok: true,
			result: { type: "object", value: {}, clipped: false, ...over },
		} as EvalOutcome);

	it("prints a value with its type", () => {
		expect(value({ type: "number", value: 42 })).toContain("number: 42");
	});

	it("says plainly when nothing was returned", () => {
		expect(value({ type: "undefined", value: "[undefined]" })).toContain(
			"returned undefined",
		);
	});

	it("prints a string without quoting it into noise", () => {
		expect(value({ type: "string", value: "Deep" })).toBe("string: Deep");
	});

	it("admits when parts were left out", () => {
		expect(value({ value: { a: 1 }, clipped: true })).toContain("left out");
	});

	it("clips a huge result and says how much is missing", () => {
		const out = value({ type: "string", value: "x".repeat(20000) });
		expect(out).toContain("more characters");
		expect(out.length).toBeLessThan(5000);
	});

	it("leads with the message when the page threw", () => {
		const out = renderEvaluation({
			ok: false,
			threw: {
				message: "TypeError: nope",
				frames: [],
				fromPromise: false,
			},
		});
		expect(out).toContain("The page threw: TypeError: nope");
	});

	it("says rejected rather than threw for a promise", () => {
		const out = renderEvaluation({
			ok: false,
			threw: { message: "Error: nope", frames: [], fromPromise: true },
		});
		expect(out).toContain("rejected");
	});

	it("hides a stack that only repeats the expression itself", () => {
		const out = renderEvaluation({
			ok: false,
			threw: {
				message: "TypeError: nope",
				frames: [
					{
						functionName: "(anonymous)",
						url: "",
						lineNumber: 0,
						columnNumber: 5,
					},
				],
				fromPromise: false,
			},
		});
		expect(out.split("\n").filter(Boolean)).toHaveLength(1);
	});

	it("shows a stack that points at real page code", () => {
		const out = renderEvaluation({
			ok: false,
			threw: {
				message: "TypeError: nope",
				frames: [
					{
						functionName: "save",
						url: "http://a/app.js",
						lineNumber: 41,
						columnNumber: 12,
					},
				],
				fromPromise: false,
			},
		});
		expect(out).toContain("http://a/app.js:42:12");
	});

	it("passes a refusal through as it stands", () => {
		expect(
			renderEvaluation({ ok: false, refused: "No expression was given." }),
		).toBe("No expression was given.");
	});
});
