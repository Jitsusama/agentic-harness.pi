import { describe, expect, it } from "vitest";
import {
	FOCUS_IN,
	FOCUS_OUT,
	focusReport,
	isBareMotion,
	isPress,
	isTyped,
	meansPresence,
} from "../../../lib/ui/terminal-reports.ts";

/** An SGR mouse report with `code` at column 10, row 5. */
const mouse = (code: number, pressed = true) =>
	`\x1b[<${code};10;5${pressed ? "M" : "m"}`;

describe("terminal reports", () => {
	it("reads which way focus went", () => {
		expect([
			focusReport(FOCUS_IN),
			focusReport(FOCUS_OUT),
			focusReport("a"),
		]).toEqual(["in", "out", undefined]);
	});

	it("tells the pointer passing over from a drag, a press and a scroll", () => {
		expect({
			passing: isBareMotion(mouse(35)),
			passingWithShift: isBareMotion(mouse(39)),
			drag: isBareMotion(mouse(32)),
			press: isBareMotion(mouse(0)),
			scroll: isBareMotion(mouse(64)),
			key: isBareMotion("a"),
		}).toEqual({
			passing: true,
			passingWithShift: true,
			drag: false,
			press: false,
			scroll: false,
			key: false,
		});
	});

	it("counts only a button going down as a press", () => {
		expect({
			down: isPress(mouse(0)),
			right: isPress(mouse(2)),
			up: isPress(mouse(0, false)),
			scroll: isPress(mouse(64)),
			drag: isPress(mouse(32)),
		}).toEqual({
			down: true,
			right: true,
			up: false,
			scroll: false,
			drag: false,
		});
	});

	it("hears the person in keys, clicks and focus arriving, not in leaving or passing", () => {
		expect({
			key: meansPresence("a"),
			click: meansPresence(mouse(0)),
			scroll: meansPresence(mouse(65)),
			focusIn: meansPresence(FOCUS_IN),
			focusOut: meansPresence(FOCUS_OUT),
			passing: meansPresence(mouse(35)),
		}).toEqual({
			key: true,
			click: true,
			scroll: true,
			focusIn: true,
			focusOut: false,
			passing: false,
		});
	});

	it("takes only keys for typing", () => {
		expect({
			key: isTyped("a"),
			escape: isTyped("\x1b"),
			arrow: isTyped("\x1b[A"),
			focusIn: isTyped(FOCUS_IN),
			focusOut: isTyped(FOCUS_OUT),
			click: isTyped(mouse(0)),
		}).toEqual({
			key: true,
			escape: true,
			arrow: true,
			focusIn: false,
			focusOut: false,
			click: false,
		});
	});
});
