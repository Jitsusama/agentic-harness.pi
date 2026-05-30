import { describe, expect, it } from "vitest";
import type { LoopState } from "../../../extensions/tdd-workflow/machine.js";
import {
	renderStatus,
	renderWidget,
} from "../../../extensions/tdd-workflow/render.js";
import { fakeTheme } from "../../lib/ui/fake-theme.js";

function loop(overrides: Partial<LoopState> = {}): LoopState {
	return {
		phase: "plan",
		assertionFailure: false,
		behaviour: "rejects an empty cart",
		iteration: 1,
		...overrides,
	};
}

describe("renderStatus", () => {
	it("shows nothing while the loop is idle", () => {
		const idle = loop({ phase: "idle", behaviour: null });
		expect(renderStatus(idle, fakeTheme())).toBeUndefined();
	});

	it("names the phase beside the glyph in its colour token", () => {
		const red = renderStatus(
			loop({ phase: "red", assertionFailure: true }),
			fakeTheme(),
		);
		expect(red).toContain("<error>\u25cf</error>");
		expect(red).toContain("red");
		const green = renderStatus(loop({ phase: "green" }), fakeTheme());
		expect(green).toContain("<success>\u2713</success>");
		expect(green).toContain("green");
	});
});

describe("renderWidget", () => {
	it("puts the iteration, phase and behaviour beside the glyph", () => {
		const [line] = renderWidget(
			loop({ phase: "write", iteration: 3 }),
			fakeTheme(),
			80,
		);
		expect(line).toContain("<warning>\u25d4</warning>");
		expect(line).toContain("write");
		expect(line).toContain("3");
		expect(line).toContain("rejects an empty cart");
	});

	it("falls back to the glyph and label when no behaviour is set", () => {
		const [line] = renderWidget(
			loop({ phase: "red", assertionFailure: true, behaviour: null }),
			fakeTheme(),
			80,
		);
		expect(line).toContain("\u25cf");
		expect(line).toContain("red");
		expect(line).not.toContain("rejects");
	});

	it("truncates a long behaviour to the available width", () => {
		const long = "x".repeat(200);
		const [line] = renderWidget(
			loop({ phase: "write", behaviour: long }),
			fakeTheme(),
			20,
		);
		expect(line).not.toContain(long);
		expect(line).toContain("x");
	});
});
