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
		redVerified: false,
		behaviour: "rejects an empty cart",
		loop: 1,
		engaged: true,
		...overrides,
	};
}

describe("renderStatus", () => {
	it("shows nothing until a loop has been engaged this session", () => {
		const idle = loop({ phase: "idle", behaviour: null, engaged: false });
		expect(renderStatus(idle, fakeTheme())).toBeUndefined();
	});

	it("shows a dim idle glyph while resting between loops", () => {
		const status = renderStatus(
			loop({ phase: "idle", behaviour: null }),
			fakeTheme(),
		);
		expect(status).toContain("<dim>\u25cc</dim>");
	});

	it("paints the phase glyph in its colour token", () => {
		const red = renderStatus(
			loop({ phase: "red", redVerified: true }),
			fakeTheme(),
		);
		expect(red).toContain("<error>\u25cf</error>");
		const green = renderStatus(loop({ phase: "green" }), fakeTheme());
		expect(green).toContain("<success>\u2713</success>");
	});
});

describe("renderWidget", () => {
	it("puts the behaviour under test beside the glyph", () => {
		const [line] = renderWidget(loop({ phase: "write" }), fakeTheme(), 80);
		expect(line).toContain("<warning>\u25d0</warning>");
		expect(line).toContain("rejects an empty cart");
	});

	it("shows only the glyph when no behaviour is set", () => {
		const [line] = renderWidget(
			loop({ phase: "idle", behaviour: null }),
			fakeTheme(),
			80,
		);
		expect(line).toContain("\u25cc");
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
