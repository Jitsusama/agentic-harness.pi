import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { overridesMark } from "../../../extensions/guard-policy-workflow/render.ts";

/**
 * The footer's mark for guard overrides.
 *
 * It spelled every override out, "guards: commit-verification report",
 * on a line shared with everything else and never shortened, so one
 * override took most of the footer. It says only that overrides are in
 * force now; `/guards` is where they are read.
 */

const theme = { fg: (colour: string, text: string) => `<${colour}>${text}` };
const plain = { fg: (_colour: string, text: string) => text };

describe("the overrides mark", () => {
	it("is absent when the session holds no overrides", () => {
		expect(overridesMark({}, theme)).toBeUndefined();
	});

	it("is a quiet flag for one override, naming nothing", () => {
		const mark = overridesMark({ "commit-verification": "report" }, theme);
		expect(mark).toBe("<muted>\u2691");
		expect(mark).not.toContain("commit-verification");
	});

	it("counts more than one, and stays a few columns wide", () => {
		const modes = {
			"commit-verification": "report",
			git: "off",
			"quest-owned-fields": "report",
		};
		expect(overridesMark(modes, theme)).toBe("<muted>\u2691 <dim>3");
		expect(visibleWidth(overridesMark(modes, plain) ?? "")).toBe(3);
	});
});
