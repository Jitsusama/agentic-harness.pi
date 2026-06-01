import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import type { LoopState } from "../../../extensions/tdd-workflow/machine.js";
import {
	renderStatus,
	renderWidget,
} from "../../../extensions/tdd-workflow/render.js";
import { fakeTheme } from "../../lib/ui/fake-theme.js";

/** Strip fakeTheme's <token> markers so width assertions see only glyph text. */
function plain(line: string): string {
	return line.replace(/<\/?[^>]+>/g, "");
}

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

	it("shows a constant TDD label beside the phase-coloured glyph", () => {
		const red = renderStatus(
			loop({ phase: "red", assertionFailure: true }),
			fakeTheme(),
		);
		expect(red).toContain("<error>\u25d5</error>");
		expect(red).toContain("TDD");
		expect(red).not.toContain("red");
		const green = renderStatus(loop({ phase: "green" }), fakeTheme());
		expect(green).toContain("<success>\u25cf</success>");
		expect(green).toContain("TDD");
		expect(green).not.toContain("green");
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
		expect(line).toContain("\u25d5");
		expect(line).toContain("red");
		expect(line).not.toContain("rejects");
	});

	it("spaces the middot from the iteration", () => {
		const [line] = renderWidget(
			loop({ phase: "write", iteration: 3 }),
			fakeTheme(),
			80,
		);
		expect(plain(line)).toContain("\u00b7 3");
		expect(plain(line)).not.toContain("\u00b73");
	});

	it("truncates a long behaviour to the available width", () => {
		const long = "x".repeat(200);
		const [line] = renderWidget(
			loop({ phase: "write", behaviour: long }),
			fakeTheme(),
			60,
		);
		expect(line).not.toContain(long);
		expect(line).toContain("x");
	});

	it("never emits a line wider than the available width", () => {
		const [line] = renderWidget(
			loop({ phase: "write", iteration: 12, behaviour: "y".repeat(200) }),
			fakeTheme(),
			24,
		);
		expect(visibleWidth(plain(line))).toBeLessThanOrEqual(24);
	});
});
