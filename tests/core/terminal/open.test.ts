import { describe, expect, it } from "vitest";
import {
	describePlan,
	openTerminal,
	openTerminals,
	printedLine,
} from "../../../lib/core/terminal/index.ts";
import { fakeDriver } from "./fakes.ts";

// Every binary these fakes name resolves, because the configured paths
// point at one that exists on any POSIX machine.
const settings = {
	drivers: {
		kitty: { path: "/bin/sh" },
		zellij: { path: "/bin/sh" },
	},
};

// The test process's own ancestry would contradict the fakes' variables.
const here = { platform: "linux", ancestry: false } as const;

describe("opening one shell", () => {
	it("opens a bare shell and types the command into it, with its variables", async () => {
		const kitty = fakeDriver("kitty");
		const opened = await openTerminal(
			{
				layout: "window",
				cwd: "/w",
				command: "pi --session 'x'",
				env: { Q: "1" },
			},
			{ ...here, settings, env: { KITTY_PANE: "1" }, drivers: [kitty] },
		);
		expect(opened.how).toBe("typed");
		expect(kitty.calls.spawned).toEqual([
			{ layout: "window", cwd: "/w", env: { Q: "1" } },
		]);
		expect(kitty.calls.typed).toEqual([
			{ handle: opened.handle, text: "Q='1' pi --session 'x'\n" },
		]);
	});

	it("plans without opening anything on a dry run", async () => {
		const kitty = fakeDriver("kitty");
		const opened = await openTerminal(
			{ layout: "tab", command: "pi" },
			{
				...here,
				settings,
				env: { KITTY_PANE: "1" },
				drivers: [kitty],
				dryRun: true,
			},
		);
		expect(opened.how).toBe("planned");
		expect(kitty.calls.spawned).toEqual([]);
		expect(describePlan(opened.plan)).toBe(
			"kitty, attached, tab (terminal from discovery, layout from the call)",
		);
	});

	it("falls to launching when the attached terminal refuses, and says so", async () => {
		const kitty = fakeDriver("kitty", { failSpawn: true, launch: true });
		const opened = await openTerminal(
			{ layout: "window", command: "pi" },
			{ ...here, settings, env: { KITTY_PANE: "1" }, drivers: [kitty] },
		);
		expect(opened.plan.tier).toBe("launched");
		expect(kitty.calls.launched).toHaveLength(1);
		expect(opened.notes[0]).toContain("kitty (attached) failed");
		expect(kitty.calls.typed).toHaveLength(1);
	});

	it("puts a pane beside the surface the session sits in", async () => {
		const zellij = fakeDriver("zellij", {
			kind: "multiplexer",
			layouts: ["tab", "pane"],
		});
		await openTerminal(
			{ layout: "pane" },
			{
				...here,
				settings,
				env: { ZELLIJ_PANE: "terminal_3" },
				drivers: [zellij],
			},
		);
		expect(zellij.calls.spawned[0]?.near?.value).toBe("terminal_3");
	});

	it("hands the lines back when nothing can open a shell", async () => {
		const opened = await openTerminal(
			{ layout: "window", cwd: "/a b", command: "pi" },
			{ ...here, env: { PATH: "" }, drivers: [], settings: { launchers: {} } },
		);
		expect(opened.how).toBe("printed");
		expect(opened.notes.at(-1)).toBe("run: (cd '/a b' && pi)");
	});
});

describe("opening several shells", () => {
	it("gathers tabs with no window to hold them into one new window", async () => {
		const kitty = fakeDriver("kitty", { launch: true });
		const outcomes = await openTerminals(
			[
				{ layout: "tab", cwd: "/a", command: "one" },
				{ layout: "tab", cwd: "/b", command: "two" },
				{ layout: "tab", cwd: "/c", command: "three" },
			],
			{ ...here, settings, env: {}, drivers: [kitty] },
		);
		expect(outcomes.every((each) => each.ok)).toBe(true);
		expect(kitty.calls.launched).toHaveLength(1);
		const window = outcomes[0]?.ok ? outcomes[0].handle : undefined;
		expect(
			kitty.calls.spawned.map((each) => [each.layout, each.near?.value]),
		).toEqual([
			["tab", window?.value],
			["tab", window?.value],
		]);
		expect(kitty.calls.typed.map((each) => each.text)).toEqual([
			"one\n",
			"two\n",
			"three\n",
		]);
	});

	it("reports each shell on its own, saying every way it was tried", async () => {
		const kitty = fakeDriver("kitty", { launch: true, failLaunch: true });
		const zellij = fakeDriver("zellij", {
			kind: "multiplexer",
			layouts: ["tab", "pane"],
		});
		const outcomes = await openTerminals(
			[
				{ layout: "window", command: "one" },
				{ layout: "pane", command: "two" },
			],
			{
				...here,
				env: { PATH: "", ZELLIJ_PANE: "terminal_1" },
				drivers: [kitty, zellij],
				settings: { ...settings, launchers: {} },
			},
		);
		expect(outcomes[0]?.ok).toBe(false);
		if (outcomes[0] && !outcomes[0].ok) {
			expect(outcomes[0].error).toContain(
				"kitty (launched) failed: kitty would not launch",
			);
		}
		expect(outcomes[1]).toMatchObject({ ok: true, how: "typed" });
	});
});

describe("the printed line", () => {
	it("carries the working directory and the variables", () => {
		expect(printedLine({ cwd: "/w", command: "pi", env: { A: "b c" } })).toBe(
			"(cd '/w' && A='b c' pi)",
		);
	});
});
