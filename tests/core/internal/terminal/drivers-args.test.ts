import { describe, expect, it } from "vitest";
import {
	classifyKittyWindows,
	createKittyDriver,
	kittyLaunchArgs,
	kittyLaunchSocket,
	kittyProcessArgs,
	kittyTabLayoutOf,
	kittyWindowIdFromLaunch,
	kittyWindowIds,
} from "../../../../lib/core/internal/terminal/drivers/kitty.ts";
import {
	tmuxPaneIdFromSpawn,
	tmuxSocketOf,
	tmuxSpawnArgs,
	tmuxTypeCalls,
} from "../../../../lib/core/internal/terminal/drivers/tmux.ts";
import {
	weztermRefocusArgs,
	weztermSocketDir,
	weztermSpawnArgs,
} from "../../../../lib/core/internal/terminal/drivers/wezterm.ts";
import {
	zellijActionArgs,
	zellijPaneId,
	zellijRefocusArgs,
	zellijTerminalPanes,
} from "../../../../lib/core/internal/terminal/drivers/zellij.ts";
import {
	type TerminalSessionHandle,
	terminalHandleKey,
} from "../../../../lib/terminal/index.ts";

const near = (
	driverId: string,
	value: string,
	scope = "s",
): TerminalSessionHandle => ({
	driverId,
	kind: `${driverId}-pane`,
	hostId: "h",
	scope,
	value,
});

describe("kitty", () => {
	it("sits in the window a holder names, reached through its socket", () => {
		const kitty = createKittyDriver({ env: () => ({}) });

		expect(
			kitty.sightWindow?.({
				terminal: "kitty",
				id: "29",
				within: "unix:@kitty-5344",
			}),
		).toMatchObject({
			driverId: "kitty",
			handle: { value: "29", scope: "unix:@kitty-5344" },
			reachable: true,
			source: "holder",
		});
	});

	it("maps the vocabulary onto kitty's launch types", () => {
		expect(
			kittyLaunchArgs({ layout: "window", takeFocus: true }, "unix:@k"),
		).toEqual(["@", "--to", "unix:@k", "launch", "--type=os-window"]);
		expect(
			kittyLaunchArgs(
				{ layout: "tab", near: near("kitty", "4"), takeFocus: true },
				"unix:@k",
			),
		).toEqual([
			"@",
			"--to",
			"unix:@k",
			"launch",
			"--type=tab",
			"--match",
			"window_id:4",
		]);
		expect(
			kittyLaunchArgs(
				{ layout: "pane", cwd: "/w", env: { A: "1" }, takeFocus: true },
				"unix:@k",
			),
		).toEqual([
			"@",
			"--to",
			"unix:@k",
			"launch",
			"--type=window",
			"--cwd",
			"/w",
			"--env",
			"A=1",
		]);
	});

	it("leaves focus where it is unless the person's own press asked for it", () => {
		// Joel, 2 November: sessions opening windows took his keys.
		for (const layout of ["tab", "pane"] as const) {
			expect(kittyLaunchArgs({ layout }, "x")).toContain("--keep-focus");
			expect(kittyLaunchArgs({ layout }, "x")).not.toContain(
				"--os-window-class",
			);
		}
		// An OS window's focus is the compositor's, so it carries the class
		// whose rule opens it unfocused.
		const window = kittyLaunchArgs({ layout: "window" }, "x");
		expect(window).toContain("--keep-focus");
		expect(window.slice(window.indexOf("--os-window-class"))[1]).toBe(
			"pi-spawned",
		);
		expect(
			kittyLaunchArgs({ layout: "window", takeFocus: true }, "x"),
		).not.toContain("--keep-focus");
		// A kitty started afresh is an OS window too.
		const started = kittyProcessArgs({ layout: "window" }, "unix:@k");
		expect(started.slice(started.indexOf("--class"))[1]).toBe("pi-spawned");
		expect(
			kittyProcessArgs({ layout: "window", takeFocus: true }, "unix:@k"),
		).not.toContain("--class");
	});

	it("runs a command directly only when one is given", () => {
		expect(
			kittyLaunchArgs({ layout: "tab", command: "pi" }, "x").slice(-4),
		).toEqual(["--", "/bin/sh", "-c", "pi"]);
	});

	it("reads the window id a launch prints", () => {
		expect(kittyWindowIdFromLaunch("12\n")).toBe("12");
		expect(kittyWindowIdFromLaunch("Error: no")).toBeUndefined();
	});

	const listing = [
		{
			id: 1,
			tabs: [{ id: 1, layout: "stack", windows: [{ id: 1 }, { id: 3 }] }],
		},
		{ id: 2, tabs: [{ id: 2, layout: "splits", windows: [{ id: 7 }] }] },
	];

	it("reads every window, and the layout of the tab holding one", () => {
		expect([...kittyWindowIds(listing)]).toEqual(["1", "3", "7"]);
		expect(kittyTabLayoutOf(listing, "3")).toBe("stack");
		expect(kittyTabLayoutOf(listing, "7")).toBe("splits");
	});

	it("classifies windows by their own socket, and an unreached one unknown", () => {
		const live = near("kitty", "3", "a");
		const gone = near("kitty", "9", "a");
		const elsewhere = near("kitty", "3", "b");
		const out = classifyKittyWindows(
			[live, gone, elsewhere],
			new Map([
				[
					"a",
					{
						reachable: true,
						hostId: "h",
						scope: "a",
						liveWindowIds: new Set(["3"]),
					},
				],
				["b", { reachable: false }],
			]),
		);
		expect(out.get(terminalHandleKey(live))).toBe("present");
		expect(out.get(terminalHandleKey(gone))).toBe("absent");
		expect(out.get(terminalHandleKey(elsewhere))).toBe("unknown");
	});

	it("names an abstract socket on Linux and a path on macOS", () => {
		expect(kittyLaunchSocket("linux", "x")).toBe(
			"unix:@agentic-harness-kitty-x",
		);
		expect(kittyLaunchSocket("darwin", "x")).toMatch(
			/^unix:\/.+agentic-harness-kitty-x\.sock$/,
		);
	});
});

describe("wezterm", () => {
	it("never lets the cli start a mux nobody can see", () => {
		for (const layout of ["window", "tab", "pane"] as const) {
			expect(weztermSpawnArgs({ layout }).slice(0, 2)).toEqual([
				"cli",
				"--no-auto-start",
			]);
		}
	});

	it("places a tab or a pane beside the surface it is near", () => {
		expect(
			weztermSpawnArgs({ layout: "tab", near: near("wezterm", "5") }),
		).toEqual(["cli", "--no-auto-start", "spawn", "--pane-id", "5"]);
		expect(
			weztermSpawnArgs({ layout: "pane", near: near("wezterm", "5") }),
		).toEqual(["cli", "--no-auto-start", "split-pane", "--pane-id", "5"]);
	});

	it("gives focus back to the pane it came from, unless the press was the person's", () => {
		const back = ["cli", "--no-auto-start", "activate-pane", "--pane-id"];
		expect(
			weztermRefocusArgs({ layout: "tab", near: near("wezterm", "5") }, "9"),
		).toEqual([...back, "5"]);
		expect(weztermRefocusArgs({ layout: "window" }, "9")).toEqual([
			...back,
			"9",
		]);
		expect(
			weztermRefocusArgs({ layout: "pane", takeFocus: true }, "9"),
		).toBeUndefined();
		expect(weztermRefocusArgs({ layout: "pane" }, undefined)).toBeUndefined();
	});

	it("finds the socket directory per platform", () => {
		expect(
			weztermSocketDir("linux", { XDG_RUNTIME_DIR: "/run/user/1" }, "/home/u"),
		).toBe("/run/user/1/wezterm");
		expect(
			weztermSocketDir("darwin", { XDG_RUNTIME_DIR: "/x" }, "/Users/u"),
		).toBe("/Users/u/.local/share/wezterm");
	});
});

describe("tmux", () => {
	it("reads the server socket out of TMUX", () => {
		expect(tmuxSocketOf("/tmp/tmux-1000/default,1234,0")).toBe(
			"/tmp/tmux-1000/default",
		);
		expect(tmuxSocketOf(undefined)).toBeUndefined();
	});

	it("prints the pane it creates, and places a tab after the window it is near", () => {
		expect(
			tmuxSpawnArgs({ layout: "tab", cwd: "/w", takeFocus: true }, "@2"),
		).toEqual([
			"new-window",
			"-P",
			"-F",
			"#{pane_id}",
			"-a",
			"-t",
			"@2",
			"-c",
			"/w",
		]);
		expect(
			tmuxSpawnArgs({
				layout: "pane",
				near: near("tmux", "%3"),
				takeFocus: true,
			}),
		).toEqual(["split-window", "-P", "-F", "#{pane_id}", "-t", "%3"]);
		expect(tmuxPaneIdFromSpawn("%12\n")).toBe("%12");
	});

	it("opens behind the pane the person is in unless their press asked", () => {
		expect(tmuxSpawnArgs({ layout: "tab" })).toContain("-d");
		expect(tmuxSpawnArgs({ layout: "pane" })).toContain("-d");
		expect(tmuxSpawnArgs({ layout: "pane", takeFocus: true })).not.toContain(
			"-d",
		);
	});

	it("types each line literally and presses Enter between them", () => {
		expect(tmuxTypeCalls("%1", "pi\n")).toEqual([
			["send-keys", "-t", "%1", "-l", "--", "pi"],
			["send-keys", "-t", "%1", "Enter"],
		]);
		expect(tmuxTypeCalls("%1", "a")).toEqual([
			["send-keys", "-t", "%1", "-l", "--", "a"],
		]);
	});
});

describe("zellij", () => {
	it("opens a tab or a pane, and runs a command with its variables inside it", () => {
		// Zellij honours --cwd only alongside a command, so the shell is named.
		expect(
			zellijActionArgs(
				{ layout: "tab", cwd: "/w", takeFocus: true },
				"/bin/zsh",
			),
		).toEqual(["action", "new-tab", "--cwd", "/w", "--", "/bin/zsh", "-l"]);
		expect(zellijActionArgs({ layout: "pane", takeFocus: true })).toEqual([
			"action",
			"new-pane",
		]);
		expect(
			zellijActionArgs({
				layout: "pane",
				command: "pi",
				env: { A: "1" },
				takeFocus: true,
			}),
		).toEqual([
			"action",
			"new-pane",
			"--",
			"/bin/sh",
			"-c",
			"A='1' exec sh -c 'pi'",
		]);
	});

	it("opens a tab behind and gives a pane's focus back, unless the press was the person's", () => {
		expect(zellijActionArgs({ layout: "tab" })).toContain("--no-focus");
		expect(zellijActionArgs({ layout: "pane" })).not.toContain("--no-focus");
		expect(zellijRefocusArgs({ layout: "pane" }, "3")).toEqual([
			"action",
			"focus-pane-id",
			"terminal_3",
		]);
		expect(zellijRefocusArgs({ layout: "tab" }, "3")).toBeUndefined();
		expect(
			zellijRefocusArgs({ layout: "pane", takeFocus: true }, "3"),
		).toBeUndefined();
		expect(zellijRefocusArgs({ layout: "pane" }, undefined)).toBeUndefined();
	});

	it("reads terminal panes, leaving plugins out, optionally by tab", () => {
		const listing = [
			{ id: 0, is_plugin: true, tab_id: 0 },
			{ id: 0, is_plugin: false, tab_id: 0 },
			{ id: 4, is_plugin: false, tab_id: 1 },
		];
		expect(zellijTerminalPanes(listing)).toEqual(["terminal_0", "terminal_4"]);
		expect(zellijTerminalPanes(listing, "1")).toEqual(["terminal_4"]);
		expect(zellijPaneId("7")).toBe("terminal_7");
		expect(zellijPaneId("terminal_7")).toBe("terminal_7");
	});
});
