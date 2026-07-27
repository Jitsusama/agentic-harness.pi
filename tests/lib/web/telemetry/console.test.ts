/**
 * Console rendering, against argument and event shapes copied
 * from a live CDP session rather than invented. A fixture that
 * does not match what Chrome actually sends proves nothing.
 */

import { describe, expect, it } from "vitest";
import {
	browserEntry,
	consoleEntry,
	consoleText,
	exceptionEntry,
	renderArg,
} from "../../../../lib/web/telemetry/console.js";

describe("renderArg", () => {
	it("reads a string as itself, unquoted at the top level", () => {
		expect(renderArg({ type: "string", value: "a plain string" })).toBe(
			"a plain string",
		);
	});

	it("reads a number", () => {
		expect(renderArg({ type: "number", value: 42, description: "42" })).toBe(
			"42",
		);
	});

	it("reads a boolean", () => {
		expect(renderArg({ type: "boolean", value: true })).toBe("true");
	});

	it("reads undefined, which carries no value at all", () => {
		expect(renderArg({ type: "undefined" })).toBe("undefined");
	});

	it("reads null, which arrives as an object with a null subtype", () => {
		expect(renderArg({ type: "object", subtype: "null", value: null })).toBe(
			"null",
		);
	});

	it("summarizes an object from the preview Chrome sends", () => {
		expect(
			renderArg({
				type: "object",
				className: "Object",
				description: "Object",
				objectId: "-3166421325413836570.3.1",
				preview: {
					type: "object",
					description: "Object",
					overflow: false,
					properties: [
						{ name: "an", type: "string", value: "object" },
						{ name: "nested", type: "object", value: "Object" },
					],
				},
			}),
		).toBe('{an: "object", nested: Object}');
	});

	it("summarizes an array, keeping the order and the types", () => {
		expect(
			renderArg({
				type: "object",
				subtype: "array",
				className: "Array",
				description: "Array(4)",
				preview: {
					type: "object",
					subtype: "array",
					description: "Array(4)",
					overflow: false,
					properties: [
						{ name: "0", type: "number", value: "1" },
						{ name: "1", type: "string", value: "two" },
						{ name: "2", type: "object", subtype: "null", value: "null" },
						{ name: "3", type: "undefined", value: "undefined" },
					],
				},
			}),
		).toBe('[1, "two", null, undefined]');
	});

	it("says when a preview was cut short rather than implying it is whole", () => {
		expect(
			renderArg({
				type: "object",
				className: "Object",
				description: "Object",
				preview: {
					type: "object",
					description: "Object",
					overflow: true,
					properties: [{ name: "align", type: "string", value: "" }],
				},
			}),
		).toBe('{align: "", ...}');
	});

	it("names a DOM node by the description Chrome gives it", () => {
		expect(
			renderArg({
				type: "object",
				subtype: "node",
				className: "HTMLHeadingElement",
				description: "h1",
				preview: {
					type: "object",
					subtype: "node",
					description: "h1",
					overflow: true,
					properties: [{ name: "align", type: "string", value: "" }],
				},
			}),
		).toBe("h1");
	});

	it("reduces an error to its message, leaving the stack to the entry", () => {
		expect(
			renderArg({
				type: "object",
				subtype: "error",
				className: "TypeError",
				description:
					"TypeError: Cannot read properties of null (reading 'boom')\n    at file:///noisy.html:18:11",
			}),
		).toBe("TypeError: Cannot read properties of null (reading 'boom')");
	});

	it("falls back to the description when there is no preview", () => {
		expect(
			renderArg({
				type: "function",
				className: "Function",
				description: "function doThing() { }",
			}),
		).toBe("function doThing() { }");
	});
});

describe("consoleText", () => {
	it("joins plain arguments with spaces, the way a console does", () => {
		expect(
			consoleText([
				{ type: "string", value: "careful" },
				{ type: "number", value: 42, description: "42" },
			]),
		).toBe("careful 42");
	});

	it("substitutes the directives Chrome sends through unsubstituted", () => {
		expect(
			consoleText([
				{ type: "string", value: "a format %s and a number %d" },
				{ type: "string", value: "value" },
				{ type: "number", value: 42, description: "42" },
			]),
		).toBe("a format value and a number 42");
	});

	it("truncates %d to an integer, as the directive means", () => {
		expect(
			consoleText([
				{ type: "string", value: "%d items" },
				{ type: "number", value: 3.7, description: "3.7" },
			]),
		).toBe("3 items");
	});

	it("keeps %f whole", () => {
		expect(
			consoleText([
				{ type: "string", value: "%f seconds" },
				{ type: "number", value: 1.5, description: "1.5" },
			]),
		).toBe("1.5 seconds");
	});

	it("drops %c and the styling it consumes, since this is not a browser", () => {
		expect(
			consoleText([
				{ type: "string", value: "%cstyled text" },
				{ type: "string", value: "color: red" },
			]),
		).toBe("styled text");
	});

	it("leaves a directive alone when no argument is left to fill it", () => {
		expect(consoleText([{ type: "string", value: "100%s complete" }])).toBe(
			"100%s complete",
		);
	});

	it("reads %% as one literal percent", () => {
		expect(consoleText([{ type: "string", value: "50%% done" }])).toBe(
			"50% done",
		);
	});

	it("appends arguments the format string did not consume", () => {
		expect(
			consoleText([
				{ type: "string", value: "%s:" },
				{ type: "string", value: "label" },
				{ type: "string", value: "extra" },
			]),
		).toBe("label: extra");
	});

	it("has nothing to say about no arguments", () => {
		expect(consoleText([])).toBe("");
	});
});

describe("consoleEntry", () => {
	it("keeps the level Chrome reports, warning and all", () => {
		const entry = consoleEntry({
			type: "warning",
			timestamp: 1000,
			args: [{ type: "string", value: "careful" }],
		});
		expect(entry.level).toBe("warning");
		expect(entry.source).toBe("console");
		expect(entry.text).toBe("careful");
	});

	it("records where the call came from, innermost frame first", () => {
		const entry = consoleEntry({
			type: "log",
			timestamp: 1000,
			args: [{ type: "string", value: "hi" }],
			stackTrace: {
				callFrames: [
					{
						functionName: "inner",
						url: "file:///noisy.html",
						lineNumber: 17,
						columnNumber: 8,
					},
					{
						functionName: "",
						url: "file:///noisy.html",
						lineNumber: 4,
						columnNumber: 0,
					},
				],
			},
		});
		expect(entry.origin).toBe("file:///noisy.html:18:9");
	});

	it("says nothing about a frame with nowhere to point", () => {
		// Code run through the debugger has frames with no name and
		// no url. Printing them gave three lines of
		// "at (anonymous) undefined" under every console.error.
		const entry = consoleEntry({
			type: "error",
			timestamp: 1000,
			args: [{ type: "string", value: "boom" }],
			stackTrace: {
				callFrames: [
					{ functionName: "", url: "", lineNumber: 0, columnNumber: 0 },
					{ functionName: "", url: "", lineNumber: 0, columnNumber: 0 },
				],
			},
		});

		expect(entry.stack).toBeUndefined();
	});

	it("keeps a named frame that has no url", () => {
		const entry = consoleEntry({
			type: "error",
			timestamp: 1000,
			args: [{ type: "string", value: "boom" }],
			stackTrace: {
				callFrames: [
					{ functionName: "onSubmit", url: "", lineNumber: 0, columnNumber: 0 },
					{
						functionName: "handler",
						url: "file:///a.js",
						lineNumber: 4,
						columnNumber: 2,
					},
				],
			},
		});

		expect(entry.stack).toContain("onSubmit");
		expect(entry.stack).not.toContain("undefined");
	});

	it("counts lines and columns from one, as an editor does", () => {
		const entry = consoleEntry({
			type: "log",
			timestamp: 1,
			args: [],
			stackTrace: {
				callFrames: [
					{
						functionName: "f",
						url: "file:///a.js",
						lineNumber: 0,
						columnNumber: 0,
					},
				],
			},
		});
		expect(entry.origin).toBe("file:///a.js:1:1");
	});
});

describe("exceptionEntry", () => {
	it("reads the message from the exception, not the bare Uncaught", () => {
		const entry = exceptionEntry(
			{
				text: "Uncaught",
				url: "file:///noisy.html",
				lineNumber: 18,
				columnNumber: 10,
				exception: {
					type: "object",
					subtype: "error",
					className: "TypeError",
					description:
						"TypeError: Cannot read properties of null (reading 'boom')\n    at file:///noisy.html:19:12",
				},
			},
			2000,
		);
		expect(entry.level).toBe("error");
		expect(entry.source).toBe("exception");
		expect(entry.text).toBe(
			"Uncaught TypeError: Cannot read properties of null (reading 'boom')",
		);
		expect(entry.stack).toContain("at file:///noisy.html:19:12");
	});

	it("keeps the promise wording, which says how it went unhandled", () => {
		const entry = exceptionEntry(
			{
				text: "Uncaught (in promise)",
				exception: {
					type: "object",
					subtype: "error",
					className: "Error",
					description: "Error: unhandled rejection",
				},
			},
			2000,
		);
		expect(entry.text).toBe("Uncaught (in promise) Error: unhandled rejection");
	});

	it("falls back to the protocol text when nothing was thrown as an error", () => {
		const entry = exceptionEntry(
			{
				text: "Uncaught",
				exception: { type: "string", value: "a bare string" },
			},
			2000,
		);
		expect(entry.text).toBe("Uncaught a bare string");
	});
});

describe("browserEntry", () => {
	it("keeps a failure the page's own console never sees", () => {
		const entry = browserEntry({
			source: "network",
			level: "error",
			text: "Failed to load resource: net::ERR_FILE_NOT_FOUND",
			url: "file:///does-not-exist.png",
			timestamp: 3000,
			networkRequestId: "52400.2",
		});
		expect(entry.source).toBe("network");
		expect(entry.level).toBe("error");
		expect(entry.origin).toBe("file:///does-not-exist.png");
		expect(entry.requestId).toBe("52400.2");
	});
});
