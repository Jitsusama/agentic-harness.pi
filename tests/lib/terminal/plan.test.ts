import { describe, expect, it } from "vitest";
import {
	discoverTerminals,
	planTerminal,
	resolveTerminalChoice,
	type TerminalChoice,
	type TerminalDriver,
	type TerminalLandscape,
	type TerminalSettings,
} from "../../../lib/terminal/index.ts";
import { fakeDriver, fakeLauncher, locating } from "./fakes.ts";

const kitty = fakeDriver("kitty", { launch: true });
const zellij = fakeDriver("zellij", {
	kind: "multiplexer",
	layouts: ["tab", "pane"],
});
const tmux = fakeDriver("tmux", {
	kind: "multiplexer",
	layouts: ["tab", "pane"],
});
const drivers: TerminalDriver[] = [kitty, zellij, tmux];

function landscape(
	env: Record<string, string>,
	options: {
		found?: string[];
		ancestry?: string[];
		platform?: "linux" | "darwin";
	} = {},
): TerminalLandscape {
	return discoverTerminals({
		platform: options.platform ?? "linux",
		env,
		drivers,
		launchers: [fakeLauncher("foot"), fakeLauncher("alacritty")],
		locate: locating(
			...(options.found ?? ["kitty", "zellij", "tmux", "foot", "alacritty"]),
		),
		...(options.ancestry ? { ancestry: options.ancestry } : {}),
	});
}

function plan(
	land: TerminalLandscape,
	call: TerminalChoice = {},
	settings?: TerminalSettings,
) {
	return planTerminal(land, resolveTerminalChoice(settings, { call }));
}

describe("which terminals the session sits in", () => {
	it("puts a multiplexer inside an emulator when nothing says otherwise", () => {
		const chain = landscape({ KITTY_PANE: "1", ZELLIJ_PANE: "2" }).chain;
		expect(chain.map((each) => each.driverId)).toEqual(["zellij", "kitty"]);
	});

	it("orders by the process ancestry when it was read", () => {
		const chain = landscape(
			{ KITTY_PANE: "1", ZELLIJ_PANE: "2", TMUX_PANE: "3" },
			{ ancestry: ["zsh", "tmux", "zsh", "zellij", "kitty", "systemd"] },
		).chain;
		expect(chain.map((each) => each.driverId)).toEqual([
			"tmux",
			"zellij",
			"kitty",
		]);
	});

	it("drops a terminal whose variables were inherited from somewhere else", () => {
		const chain = landscape(
			{ KITTY_PANE: "1", TMUX_PANE: "3" },
			{ ancestry: ["zsh", "kitty"] },
		).chain;
		expect(chain.map((each) => each.driverId)).toEqual(["kitty"]);
	});

	it("keeps the emulator outside a multiplexer whose server left it behind", () => {
		// A zellij or tmux server detaches from the terminal that started it,
		// so the emulator showing it is not an ancestor of the session.
		const chain = landscape(
			{ KITTY_PANE: "1", ZELLIJ_PANE: "2" },
			{ ancestry: ["zsh", "zellij", "systemd"] },
		).chain;
		expect(chain.map((each) => each.driverId)).toEqual(["zellij", "kitty"]);
	});

	it("adds a terminal the ancestry shows but whose variables are gone, as unreachable", () => {
		const [only] = landscape({}, { ancestry: ["zsh", "kitty"] }).chain;
		expect(only).toMatchObject({
			driverId: "kitty",
			reachable: false,
			source: "ancestry",
		});
	});
});

describe("planning with nothing chosen", () => {
	it("attaches to the terminal the session is in", () => {
		const result = plan(landscape({ KITTY_PANE: "1" }), { layout: "window" });
		expect(result).toMatchObject({
			ok: true,
			plan: {
				terminal: "kitty",
				tier: "attached",
				control: "deep",
				layout: "window",
			},
		});
	});

	it("sends a tab to the innermost terminal, and a window to the innermost that can make one", () => {
		const land = landscape({ KITTY_PANE: "1", ZELLIJ_PANE: "2" });
		expect(plan(land, { layout: "tab" })).toMatchObject({
			plan: { terminal: "zellij" },
		});
		expect(plan(land, { layout: "window" })).toMatchObject({
			plan: { terminal: "kitty" },
		});
	});

	it("sends a tab to the outermost terminal when nesting says so, and says why", () => {
		const land = landscape({ KITTY_PANE: "1", ZELLIJ_PANE: "2" });
		const result = plan(land, { layout: "tab", nesting: { tab: "outermost" } });
		expect(result).toMatchObject({
			ok: true,
			plan: { terminal: "kitty", tier: "attached" },
		});
		if (result.ok) expect(result.plan.notes.join()).toContain("outermost");
	});

	it("launches the terminal the session sits in when it cannot be reached", () => {
		const land = landscape({ KITTY_PANE: "1", KITTY_SOCK: "none" });
		expect(plan(land, { layout: "window" })).toMatchObject({
			plan: {
				terminal: "kitty",
				tier: "launched",
				control: "deep",
				binary: "/bin/kitty",
			},
		});
	});

	it("opens a tab with nothing to hold it in a new window, and says so", () => {
		const result = plan(landscape({}), { layout: "tab" });
		expect(result).toMatchObject({
			ok: true,
			plan: { tier: "launched", layout: "tab" },
		});
		if (result.ok)
			expect(result.plan.notes.join()).toContain("new kitty window");
	});

	it("launches blind when no deep terminal is installed", () => {
		const result = plan(landscape({}, { found: ["alacritty"] }), {
			layout: "window",
		});
		expect(result).toMatchObject({
			plan: {
				terminal: "alacritty",
				tier: "launched",
				control: "blind",
				binary: "/bin/alacritty",
			},
		});
	});

	it("prints the command when nothing at all can open a shell", () => {
		expect(
			plan(landscape({}, { found: [] }), { layout: "window" }),
		).toMatchObject({
			ok: true,
			plan: { terminal: "fallback", tier: "printed" },
		});
	});

	it("refuses a pane the call asked for when no terminal can split", () => {
		const result = plan(landscape({}, { found: ["kitty"] }), {
			layout: "pane",
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.refusal).toContain(
				"a pane splits a terminal the session is in",
			);
	});

	it("gives a pane from a setting way to a tab, and names the substitution", () => {
		const result = plan(landscape({}), {}, { defaults: { layout: "pane" } });
		expect(result).toMatchObject({
			ok: true,
			plan: { layout: "tab", tier: "launched" },
		});
		if (result.ok)
			expect(result.plan.notes[0]).toContain(
				"instead of the pane terminal.defaults asked for",
			);
	});
});

describe("planning with a terminal named", () => {
	it("refuses a terminal whose program was not found, listing the ones that were", () => {
		const result = plan(landscape({}, { found: ["foot"] }), {
			driver: "kitty",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.refusal).toContain("program was not found");
			expect(result.refusal).toContain("foot");
		}
	});

	it("refuses a terminal it does not know", () => {
		const result = plan(landscape({}), { driver: "hyper" });
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.refusal).toContain("no terminal this library knows");
	});

	it("refuses a window from a multiplexer the call named", () => {
		const result = plan(landscape({ TMUX_PANE: "%1" }), {
			driver: "tmux",
			layout: "window",
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.refusal).toContain("tmux cannot open a window");
	});

	it("gives a window from a setting way to a tab in the named multiplexer", () => {
		const result = plan(
			landscape({ TMUX_PANE: "%1" }),
			{ driver: "tmux" },
			{ defaults: { layout: "window" } },
		);
		expect(result).toMatchObject({
			ok: true,
			plan: { terminal: "tmux", layout: "tab" },
		});
	});

	it("launches a named launcher blind", () => {
		expect(
			plan(landscape({}), { driver: "foot", layout: "window" }),
		).toMatchObject({
			plan: { terminal: "foot", control: "blind", terminalFrom: "call" },
		});
	});

	it("names the layer that chose the terminal", () => {
		const result = plan(
			landscape({ KITTY_PANE: "1" }),
			{},
			{ defaults: { driver: "kitty" } },
		);
		expect(result).toMatchObject({ plan: { terminalFrom: "defaults" } });
	});
});

describe("launchers by platform", () => {
	it("leaves out a launcher that does not run on the platform", () => {
		const land = discoverTerminals({
			platform: "darwin",
			env: {},
			drivers: [],
			launchers: [{ ...fakeLauncher("foot"), platforms: { darwin: false } }],
			locate: locating("foot"),
		});
		expect(land.launchers).toEqual([]);
	});

	it("needs a macOS bundle installed for a form that opens one", () => {
		const spec = {
			...fakeLauncher("ghostty"),
			platforms: {
				darwin: {
					binary: "open",
					app: "Ghostty",
					window: ["-na", "Ghostty", "--args", "-e", "{argv}"],
				},
			},
		};
		const base = {
			platform: "darwin" as const,
			env: {},
			drivers: [],
			launchers: [spec],
			locate: locating("open"),
		};
		expect(
			discoverTerminals({ ...base, appInstalled: () => false }).launchers,
		).toEqual([]);
		expect(
			discoverTerminals({ ...base, appInstalled: () => true }).launchers[0]
				?.binary,
		).toBe("/bin/open");
	});

	it("tries the launcher $TERMINAL names first", () => {
		const land = landscape(
			{ TERMINAL: "/usr/bin/alacritty" },
			{ found: ["foot", "alacritty"] },
		);
		expect(land.launchers.map((each) => each.id)).toEqual([
			"alacritty",
			"foot",
		]);
	});
});
