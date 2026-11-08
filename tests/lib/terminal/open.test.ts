import { describe, expect, it } from "vitest";
import {
	describePlan,
	type OpenRequest,
	openTerminal,
	openTerminals,
	printedLine,
} from "../../../lib/terminal/index.ts";
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
		expect(outcomes.filter((each) => !each.ok)).toEqual([]);
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

	it("opens them one at a time, each begun a pace after the last, when paced", async () => {
		const kitty = fakeDriver("kitty", { launch: true });
		const began: number[] = [];
		const launch = kitty.launch?.bind(kitty);
		kitty.launch = async (...args) => {
			began.push(Date.now());
			if (!launch) throw new Error("the fake has no launch");
			return launch(...args);
		};
		const pace = 80;

		const outcomes = await openTerminals(
			[
				{ layout: "window", command: "one" },
				{ layout: "window", command: "two" },
				{ layout: "window", command: "three" },
			],
			{ ...here, settings, env: {}, drivers: [kitty], paceMs: pace },
		);

		expect(outcomes.filter((each) => !each.ok)).toEqual([]);
		expect(kitty.calls.typed.map((each) => each.text)).toEqual([
			"one\n",
			"two\n",
			"three\n",
		]);
		const gaps = began.slice(1).map((at, index) => at - (began[index] ?? at));
		// A timer may fire a millisecond early by the clock it is read on.
		expect(
			gaps.every((gap) => gap >= pace - 1),
			`gaps ${gaps}`,
		).toBe(true);
	});

	it("plans several without waiting, however paced", async () => {
		const kitty = fakeDriver("kitty", { launch: true });
		const started = Date.now();

		await openTerminals(
			[
				{ layout: "window", command: "one" },
				{ layout: "window", command: "two" },
			],
			{
				...here,
				settings,
				env: {},
				drivers: [kitty],
				paceMs: 60_000,
				dryRun: true,
			},
		);

		expect(Date.now() - started).toBeLessThan(30_000);
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
		expect(outcomes[0]).toMatchObject({ ok: false });
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

describe("a window opened without focus, under niri", () => {
	const title = "π - Harness - agentic-harness.pi";
	const orchestrator = "π - Orchestrator - core.nix";
	interface Seen {
		title: string;
		workspace_id: number;
		id?: number;
		app_id?: string;
		layout?: { pos_in_scrolling_layout: [number, number] };
	}
	/**
	 * A niri that holds these windows, and once kitty has opened one, that
	 * one too on workspace 1; it answers each action as `act` says.
	 */
	function niri(
		kitty: ReturnType<typeof fakeDriver>,
		windows: Seen[],
		act: (request: unknown) => unknown = () => ({ Ok: "Handled" }),
	) {
		const asked: unknown[] = [];
		const call = async (request: unknown) => {
			asked.push(request);
			if (request !== "Windows") return act(request);
			const opened = kitty.calls.spawned[0]?.windowClass;
			const extra: Seen[] = opened
				? [{ title: "zsh", workspace_id: 1, id: 99, app_id: opened }]
				: [];
			return { Ok: { Windows: [...windows, ...extra] } };
		};
		return { asked, call };
	}
	const refusing = (request: unknown) =>
		JSON.stringify(request).includes("OpenNextWindowOn")
			? { Err: "error parsing request" }
			: { Ok: "Handled" };
	const open = (
		kitty: ReturnType<typeof fakeDriver>,
		call: (request: unknown) => Promise<unknown>,
		request: Partial<OpenRequest> = {},
	) =>
		openTerminal(
			{ layout: "window", command: "pi", ...request },
			{
				...here,
				settings,
				env: { KITTY_PANE: "7" },
				drivers: [kitty],
				niri: call,
				opened: { waitMs: 200, everyMs: 5 },
			},
		);

	it("opens on the workspace of the asking session's window, by a class of its own", async () => {
		const kitty = fakeDriver("kitty", { titles: { "7": title } });
		const desk = niri(kitty, [
			{ title: "π - Other - delta", workspace_id: 1 },
			{ title, workspace_id: 3 },
		]);
		const opened = await open(kitty, desk.call);
		const windowClass = kitty.calls.spawned[0]?.windowClass;

		expect(windowClass).toMatch(/^pi-spawned\.[0-9]+$/);
		expect(desk.asked[1]).toEqual({
			Action: {
				OpenNextWindowOn: { app_id: windowClass, reference: { Id: 3 } },
			},
		});
		expect(opened.notes).toContain(
			"opens on niri workspace 3, beside the window it belongs with",
		);
	});

	it("opens beside its orchestrator's window before the asker's, after the columns that sort before it", async () => {
		const kitty = fakeDriver("kitty", { titles: { "7": title } });
		const at = (column: number) => ({
			pos_in_scrolling_layout: [column, 1] as [number, number],
		});
		const desk = niri(kitty, [
			{ title, workspace_id: 3 },
			{ title: orchestrator, workspace_id: 5, layout: at(1) },
			{ title: "π - Alpha - core.nix", workspace_id: 5, layout: at(2) },
			{ title: "π - Zulu - core.nix", workspace_id: 5, layout: at(3) },
		]);
		const opened = await open(kitty, desk.call, {
			window: {
				beside: [orchestrator],
				first: orchestrator,
				title: "π - Mike - core.nix",
			},
		});

		expect(desk.asked[1]).toMatchObject({
			Action: { OpenNextWindowOn: { reference: { Id: 5 }, column: 3 } },
		});
		expect(opened.notes).toContain(
			"opens on niri workspace 5, column 3, beside the window it belongs with",
		);
	});

	it("moves the window there once it opens, without focus, when niri refuses the ask", async () => {
		const kitty = fakeDriver("kitty", { titles: { "7": title } });
		const desk = niri(kitty, [{ title, workspace_id: 3 }], refusing);
		const opened = await open(kitty, desk.call);

		expect(desk.asked).toContainEqual({
			Action: {
				MoveWindowToWorkspace: {
					window_id: 99,
					reference: { Id: 3 },
					focus: false,
				},
			},
		});
		expect(opened.notes.join(" ")).toContain(
			"moved to niri workspace 3 once it opened",
		);
	});

	it("leaves a window that never opens where it is", async () => {
		const kitty = fakeDriver("kitty", { titles: { "7": title } });
		const asked: unknown[] = [];
		const opened = await open(kitty, async (request) => {
			asked.push(request);
			return request === "Windows"
				? { Ok: { Windows: [{ title, workspace_id: 3 }] } }
				: refusing(request);
		});

		expect(JSON.stringify(asked)).not.toContain("MoveWindowToWorkspace");
		expect(opened.notes.join(" ")).not.toContain("niri workspace");
	});

	it("asks nothing of where when two windows carry the asker's title", async () => {
		const kitty = fakeDriver("kitty", { titles: { "7": title } });
		const desk = niri(kitty, [
			{ title, workspace_id: 3 },
			{ title, workspace_id: 5 },
		]);
		await open(kitty, desk.call);

		expect(desk.asked).toEqual(["Windows"]);
		expect(kitty.calls.spawned[0]?.windowClass).toBeUndefined();
	});

	it("asks nothing for a tab, which opens in the asker's own window", async () => {
		const kitty = fakeDriver("kitty", { titles: { "7": title } });
		const desk = niri(kitty, [{ title, workspace_id: 3 }]);
		await open(kitty, desk.call, { layout: "tab" });

		expect(desk.asked).toEqual([]);
	});
});

describe("a command that ends its window", () => {
	it("replaces the shell it is typed into, so the window closes with it", async () => {
		const kitty = fakeDriver("kitty");
		await openTerminal(
			{
				layout: "tab",
				command: "pi --session abc",
				env: { A: "b c" },
				endsWithCommand: true,
			},
			{ ...here, settings, env: { KITTY_PANE: "1" }, drivers: [kitty] },
		);

		expect(kitty.calls.typed[0]?.text).toBe(
			"exec env A='b c' pi --session abc\n",
		);
	});
});
