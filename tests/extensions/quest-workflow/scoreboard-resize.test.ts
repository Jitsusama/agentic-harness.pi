import { describe, expect, it } from "vitest";
import { updateScoreboard } from "../../../extensions/quest-workflow/index";
import { createQuestState } from "../../../extensions/quest-workflow/state";

const theme = { fg: (_token: string, text: string) => text } as never;

type WidgetValue =
	| string[]
	| ((
			tui: unknown,
			theme: unknown,
	  ) => {
			render(width: number): string[];
			invalidate(): void;
	  })
	| undefined;

function fakeUi() {
	const captured: { status?: string; widget?: WidgetValue } = {};
	return {
		theme,
		setStatus: (_key: string, value: string | undefined) => {
			captured.status = value;
		},
		setWidget: (_key: string, value: WidgetValue) => {
			captured.widget = value;
		},
		captured,
	};
}

function loadedState() {
	const state = createQuestState({ questsRoot: "/tmp/does-not-matter" });
	state.questId = "QEST-20260101-AAAAAA";
	state.questKind = "quest";
	state.questStatus = "active";
	state.questTitle =
		"A Deliberately Long Quest Title That Will Need Truncating At Narrow Widths";
	state.documentKind = "plan";
	state.documentStage = "build";
	state.documentTitle = "The Plan Document With A Long Title Too";
	state.done = 2;
	state.total = 5;
	state.currentItem = "wire the resize-aware widget callback";
	return state;
}

describe("updateScoreboard resize behaviour", () => {
	it("registers a widget callback that reflows to the render width", () => {
		const ui = fakeUi();
		updateScoreboard(loadedState(), { ui } as never);

		const widget = ui.captured.widget;
		expect(typeof widget).toBe("function");
		if (typeof widget !== "function") throw new Error("expected a callback");
		const component = widget(null, theme);

		// Strip ANSI SGR codes to measure the visible width. The regex is
		// built from a string so the escape byte is not a literal control
		// character in the source.
		const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
		const visible = (s: string) => s.replace(ansi, "").length;
		const narrow = component.render(40);
		const wide = component.render(120);
		// Each line honours its own width budget, so a resize reflows
		// rather than freezing at the width it was first painted at.
		expect(visible(narrow[0])).toBeLessThanOrEqual(40);
		expect(visible(wide[0])).toBeLessThanOrEqual(120);
		// The wide render reveals the trailing detail the narrow one had
		// to truncate away: proof the width argument drives the output.
		expect(wide[0]).toContain("wire the resize-aware widget callback");
		expect(narrow[0]).not.toContain("wire the resize-aware widget callback");
	});

	it("pushes a width-independent status so the footer can retruncate", () => {
		const ui = fakeUi();
		updateScoreboard(loadedState(), { ui } as never);
		// The status carries the full id rather than a width-collapsed
		// label, so widening the terminal reveals it again.
		expect(ui.captured.status).toContain("QEST-20260101-AAAAAA");
	});

	it("clears the status and widget when no quest is loaded", () => {
		const ui = fakeUi();
		const state = createQuestState({ questsRoot: "/tmp/x" });
		updateScoreboard(state, { ui } as never);
		expect(ui.captured.status).toBeUndefined();
		expect(ui.captured.widget).toBeUndefined();
	});
});
