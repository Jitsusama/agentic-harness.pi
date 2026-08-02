/**
 * A row redrawn is the same row, not another one.
 *
 * Pi hands each renderer the component it returned last time and asks
 * for it back, mutated. Every renderer in this package ignored that and
 * built a new `Text` on every pass, which is the documented way to get a
 * row that has been drawn twice appearing twice: the transcript is left
 * holding a component nobody updates beside the one that replaced it.
 *
 * It shows against a tool that renders more than once, which in practice
 * is any tool slow enough to be drawn while it is still running. The
 * effect is a ghost of the call line above the finished row.
 *
 * Reuse is also the cheaper path, since a Text caches its own layout and
 * a fresh one throws that away on every keystroke elsewhere on screen.
 */

import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderToolCall } from "../../../lib/ui/tool-call.js";
import { fakeTheme } from "./fake-theme.js";

const THEME = fakeTheme();

describe("drawing the same tool row again", () => {
	it("hands back the very component it was given", () => {
		const first = renderToolCall(
			{ tool: "review_say", action: "reply" },
			THEME,
		);
		const again = renderToolCall(
			{ tool: "review_say", action: "reply" },
			THEME,
			first,
		);
		expect(again).toBe(first);
	});

	it("shows the new text, not the text it was built with", () => {
		const first = renderToolCall(
			{ tool: "review_offer", action: "merge" },
			THEME,
		);
		const again = renderToolCall(
			{ tool: "review_offer", action: "close" },
			THEME,
			first,
		);
		expect(again.render(80).join("\n")).toContain("close");
		expect(again.render(80).join("\n")).not.toContain("merge");
	});

	it("still builds one when there is nothing to reuse", () => {
		const made = renderToolCall({ tool: "review_see", action: "diff" }, THEME);
		expect(made).toBeInstanceOf(Text);
		expect(made.render(80).join("\n")).toContain("diff");
	});
});
