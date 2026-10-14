import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { terminalOptions } from "../../../extensions/quest-workflow/terminal";
import { resolveTerminalChoice } from "../../../lib/terminal/index";

let root: string;
let saved: string | undefined;

function writeConfig(sections: Record<string, unknown>): void {
	const dir = join(root, "pi", "agentic-harness.pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({ version: 1, sections }),
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "terminal-settings-"));
	saved = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = root;
});

afterEach(() => {
	if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = saved;
	rmSync(root, { recursive: true, force: true });
});

describe("the terminal options a quest verb opens with", () => {
	it("takes the quest's setting over the defaults, and the call's over both", async () => {
		writeConfig({
			terminal: {
				defaults: { driver: "kitty", layout: "window" },
				quests: { "QEST-1": { driver: "zellij" } },
			},
		});
		const read = await terminalOptions(
			{ nesting: "outermost" },
			{ questId: "QEST-1" },
		);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		const chosen = resolveTerminalChoice(read.options.settings, {
			...read.options.place,
			...(read.options.call ? { call: read.options.call } : {}),
		});
		expect(chosen.driver).toEqual({ value: "zellij", from: "quest" });
		expect(chosen.layout).toEqual({ value: "window", from: "defaults" });
		expect(chosen.nesting.tab).toEqual({ value: "outermost", from: "call" });
	});

	it("refuses a section that is wrong, naming the field and the file", async () => {
		writeConfig({ terminal: { defaults: { layout: "split" } } });
		const read = await terminalOptions({}, {});
		expect(read.ok).toBe(false);
		if (!read.ok) {
			expect(read.refusal).toContain("terminal.defaults.layout");
			expect(read.refusal).toContain("config.json");
		}
	});

	it("refuses a layout or nesting the call cannot mean", async () => {
		expect((await terminalOptions({ layout: "split" }, {})).ok).toBe(false);
		expect((await terminalOptions({ nesting: "middle" }, {})).ok).toBe(false);
	});

	it("passes a dry run through", async () => {
		const read = await terminalOptions({ dryRun: true, layout: "tab" }, {});
		expect(read).toMatchObject({
			ok: true,
			layout: "tab",
			options: { dryRun: true },
		});
	});
});
