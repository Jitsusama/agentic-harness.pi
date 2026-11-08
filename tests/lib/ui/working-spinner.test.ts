import type { WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FOCUS_IN, FOCUS_OUT } from "../../../lib/ui/terminal-reports.ts";
import {
	type SpinnerUI,
	STILL_MARK,
	stillWhereUnfocused,
} from "../../../lib/ui/working-spinner.ts";

/** A UI that records each indicator set and hands input to its listener. */
function fakeUI() {
	const set: (string | undefined)[] = [];
	let listener: ((data: string) => unknown) | undefined;
	const ui: SpinnerUI = {
		onTerminalInput(handler) {
			listener = handler;
			return () => {
				listener = undefined;
			};
		},
		setWorkingIndicator(options?: WorkingIndicatorOptions) {
			set.push(options === undefined ? "spinner" : options.frames?.join(""));
		},
		theme: { fg: (_color, text) => `<${text}>` },
	};
	const type = (data: string) => listener?.(data);
	return { ui, set, type, listening: () => listener !== undefined };
}

const STILL = `<${STILL_MARK}>`;

describe("the working spinner", () => {
	it("starts still, turns on focus or a key, and stills when focus leaves", () => {
		const { ui, set, type } = fakeUI();
		stillWhereUnfocused(ui);
		type(FOCUS_IN);
		type(FOCUS_OUT);
		type("a");
		expect(set).toEqual([STILL, "spinner", STILL, "spinner"]);
	});

	it("sets nothing for the pointer passing over, a scroll, or a state it is in", () => {
		const { ui, set, type } = fakeUI();
		stillWhereUnfocused(ui);
		type("\x1b[<35;10;5M");
		type("\x1b[<64;10;5M");
		type(FOCUS_OUT);
		type("a");
		type("b");
		expect(set).toEqual([STILL, "spinner"]);
	});

	it("turns for a click, which reaches only the focused window", () => {
		const { ui, set, type } = fakeUI();
		stillWhereUnfocused(ui);
		type("\x1b[<0;10;5M");
		expect(set).toEqual([STILL, "spinner"]);
	});

	it("passes every input on to pi", () => {
		const { ui, type } = fakeUI();
		stillWhereUnfocused(ui);
		expect([type(FOCUS_IN), type("a")]).toEqual([undefined, undefined]);
	});

	it("stops listening and puts pi's spinner back when stopped", () => {
		const { ui, set, listening } = fakeUI();
		const stop = stillWhereUnfocused(ui);
		stop();
		expect({ set, listening: listening() }).toEqual({
			set: [STILL, "spinner"],
			listening: false,
		});
	});
});
