import { describe, expect, it } from "vitest";
import {
	normalizeListeners,
	type RawListener,
	renderListeners,
} from "../../../../lib/web/element/index.js";

/** A capture shaped the way Chrome reports listeners. */
const CAPTURE: readonly RawListener[] = [
	{
		type: "click",
		useCapture: false,
		passive: true,
		once: false,
		scriptId: "42",
		lineNumber: 5,
		columnNumber: 19,
	},
	{
		type: "keydown",
		useCapture: true,
		passive: false,
		once: true,
		scriptId: "42",
		lineNumber: 6,
		columnNumber: 20,
	},
];

describe("normalizeListeners", () => {
	it("says what each handler responds to", () => {
		expect(normalizeListeners(CAPTURE).map((l) => l.type)).toEqual([
			"click",
			"keydown",
		]);
	});

	it("carries the flags that change how a handler behaves", () => {
		const [click, keydown] = normalizeListeners(CAPTURE);
		expect([click.passive, click.capture, click.once]).toEqual([
			true,
			false,
			false,
		]);
		expect([keydown.passive, keydown.capture, keydown.once]).toEqual([
			false,
			true,
			true,
		]);
	});

	it("says where the handler was registered", () => {
		expect(normalizeListeners(CAPTURE)[0].source).toEqual({
			script: "42",
			line: 5,
			column: 19,
		});
	});

	it("copes with a capture that says nothing about location", () => {
		const [only] = normalizeListeners([{ type: "click" }]);
		expect(only).toEqual({
			type: "click",
			capture: false,
			passive: false,
			once: false,
		});
	});
});

describe("renderListeners", () => {
	it("lists each handler with the flags that matter", () => {
		expect(renderListeners(normalizeListeners(CAPTURE))).toBe(
			["click  passive  line 6", "keydown  capture  once  line 7"].join("\n"),
		);
	});

	it("says plainly when nothing is listening", () => {
		// An element with no handlers is the answer to why a click
		// did nothing, so it has to be stated rather than omitted.
		expect(renderListeners([])).toBe("Nothing is listening on this element.");
	});
});
