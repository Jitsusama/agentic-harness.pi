import { describe, expect, it } from "vitest";
import {
	parseTerminalSettings,
	resolveTerminalChoice,
	type TerminalSettings,
} from "../../../lib/terminal/index.ts";

const settings: TerminalSettings = {
	defaults: { driver: "kitty", layout: "window" },
	projects: { "github:o/r": { layout: "tab", nesting: { tab: "outermost" } } },
	quests: { "QEST-1": { driver: "zellij" } },
};

describe("choosing a terminal, a layout and a nesting", () => {
	it("takes each from the first layer that names it, independently", () => {
		const chosen = resolveTerminalChoice(settings, {
			quest: "QEST-1",
			project: "github:o/r",
		});
		expect(chosen.driver).toEqual({ value: "zellij", from: "quest" });
		expect(chosen.layout).toEqual({ value: "tab", from: "project" });
		expect(chosen.nesting.tab).toEqual({ value: "outermost", from: "project" });
		expect(chosen.nesting.pane).toEqual({
			value: "innermost",
			from: "built in",
		});
	});

	it("lets the call outrank every setting", () => {
		const chosen = resolveTerminalChoice(settings, {
			quest: "QEST-1",
			call: { driver: "wezterm", layout: "pane", nesting: "outermost" },
		});
		expect(chosen.driver).toEqual({ value: "wezterm", from: "call" });
		expect(chosen.layout).toEqual({ value: "pane", from: "call" });
		expect(chosen.nesting.window).toEqual({ value: "outermost", from: "call" });
	});

	it("falls to the defaults, then to the built-in tab and innermost", () => {
		expect(resolveTerminalChoice(settings).layout).toEqual({
			value: "window",
			from: "defaults",
		});
		const bare = resolveTerminalChoice(undefined);
		expect(bare.driver).toBeUndefined();
		expect(bare.layout).toEqual({ value: "tab", from: "built in" });
		expect(bare.nesting.tab.value).toBe("innermost");
	});
});

describe("reading the terminal section", () => {
	it("reads an absent section as no settings", () => {
		expect(parseTerminalSettings(undefined)).toEqual({ ok: true, value: {} });
	});

	it("reads a full section", () => {
		const parsed = parseTerminalSettings({
			...settings,
			drivers: { kitty: { path: "/opt/kitty" } },
			launchers: {
				foot: {
					window: ["--working-directory={cwd}", "--", "{argv}"],
					platforms: { darwin: false },
				},
			},
			wrap: ["direnv", "exec", "{cwd}"],
		});
		expect(parsed.ok).toBe(true);
	});

	it.each([
		[{ defaults: { layout: "split" } }, "terminal.defaults.layout"],
		[{ defaults: { colour: "red" } }, 'unknown field "colour"'],
		[
			{ projects: { x: { nesting: { tab: "middle" } } } },
			'terminal.projects["x"].nesting.tab',
		],
		[{ launchers: { foot: { window: ["--"] } } }, 'needs an "{argv}"'],
		[{ drivers: { kitty: { path: "" } } }, "terminal.drivers.kitty.path"],
		[{ wrap: "direnv exec" }, "terminal.wrap must be a list"],
	])("refuses %j naming the field", (section, named) => {
		const parsed = parseTerminalSettings(section);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain(named);
	});
});
