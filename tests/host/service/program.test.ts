/** The host program judges what it was given before it holds, pins or listens anything. */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	conversationBase,
	HostMisconfigured,
	hostPackageDir,
	nameViewerTerminal,
	startHostProgram,
	startupQuestions,
	themeStarter,
} from "../../../host/service/program.ts";

const STARTUP_INSTALL_KEY = Symbol.for("pi.subagent.startupPiInstall");

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h2-program-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("conversationBase", () => {
	it("keeps the realm's environment but not systemd's hand-over or the host's pi", () => {
		const host = {
			HOME: "/home/someone",
			MYCELIUM_REALM: "work",
			SHOPIFY_PROXY_ORIGIN: "https://proxy.example",
			NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
			WATCHDOG_USEC: "1000",
			LISTEN_FDS: "1",
			PI_PACKAGE_DIR: "/nix/store/host-pi",
		};
		expect(conversationBase(host)).toEqual({
			HOME: "/home/someone",
			MYCELIUM_REALM: "work",
			SHOPIFY_PROXY_ORIGIN: "https://proxy.example",
		});
		expect(host.NOTIFY_SOCKET, "the host keeps its own").toBe(
			"/run/user/1000/systemd/notify",
		);
	});
});

describe("nameViewerTerminal", () => {
	it("takes the viewers' terminal to be kitty unless the unit says otherwise", () => {
		const env: NodeJS.ProcessEnv = {
			HOME: "/home/someone",
			PI_IMAGE_PROTOCOL: "none",
			PI_TRUE_COLOR: "0",
		};
		nameViewerTerminal(env);
		expect(env).toEqual({
			HOME: "/home/someone",
			PI_IMAGE_PROTOCOL: "none",
			PI_TRUE_COLOR: "0",
			PI_HYPERLINKS: "1",
		});
		const bare: NodeJS.ProcessEnv = {};
		nameViewerTerminal(bare);
		expect(bare).toEqual({
			PI_IMAGE_PROTOCOL: "kitty",
			PI_TRUE_COLOR: "1",
			PI_HYPERLINKS: "1",
		});
	});
});

describe("themeStarter", () => {
	const pi = (theme: unknown, calls: unknown[][], created: unknown[][]) => ({
		initTheme: (...args: unknown[]) => calls.push(args),
		getAgentDir: () => "/agent",
		// A function with a create member, as pi's class looks from outside.
		SettingsManager: Object.assign(() => undefined, {
			create: (...args: unknown[]) => {
				created.push(args);
				return { getTheme: () => theme };
			},
		}),
	});

	it("starts the theme the person's settings name, without a watcher, only when asked", () => {
		const calls: unknown[][] = [];
		const created: unknown[][] = [];
		const start = themeStarter(
			pi("jitsusama", calls, created),
			"/home/someone",
		);
		expect(calls, "nothing starts before the host asks").toEqual([]);
		start();
		expect(created).toEqual([["/home/someone", "/agent"]]);
		expect(calls).toEqual([["jitsusama", false]]);
	});

	it("leaves the theme to pi when the settings name none", () => {
		const calls: unknown[][] = [];
		themeStarter(pi(undefined, calls, []), "/home/someone")();
		expect(calls).toEqual([[undefined, false]]);
	});

	it("refuses a pi lacking what starting a theme needs", () => {
		const { initTheme: _, ...lacking } = pi("x", [], []);
		expect(() => themeStarter(lacking, "/")).toThrow(
			"The host's pi lacks initTheme, SettingsManager or getAgentDir",
		);
	});
});

describe("startupQuestions", () => {
	class ExtensionSelectorComponent {}
	class TuiMainScreen {}

	it("takes the selector pi asks its startup questions with, and the TUI it draws in", () => {
		expect(
			startupQuestions({
				codingAgent: { ExtensionSelectorComponent },
				tui: { TuiMainScreen },
			}),
		).toEqual({
			selector: ExtensionSelectorComponent,
			mainScreen: TuiMainScreen,
		});
	});

	it("refuses a pi without either", () => {
		for (const codingAgent of [{}, { ExtensionSelectorComponent: "no" }])
			expect(() =>
				startupQuestions({ codingAgent, tui: { TuiMainScreen } }),
			).toThrow("The host's pi lacks ExtensionSelectorComponent");
		expect(() =>
			startupQuestions({
				codingAgent: { ExtensionSelectorComponent },
				tui: {},
			}),
		).toThrow("The host's pi-tui lacks TuiMainScreen");
	});
});

describe("hostPackageDir", () => {
	it("takes only an absolute PI_PACKAGE_DIR", () => {
		expect(hostPackageDir({ PI_PACKAGE_DIR: "/pi" })).toBe("/pi");
		for (const env of [{}, { PI_PACKAGE_DIR: "" }, { PI_PACKAGE_DIR: "pi" }])
			expect(() => hostPackageDir(env)).toThrow(
				"PI_PACKAGE_DIR must name the host's pi install",
			);
	});
});

describe("startHostProgram", () => {
	const good = () => ({
		MYCELIUM_REALM: "work",
		XDG_RUNTIME_DIR: join(dir, "run"),
		PI_PACKAGE_DIR: join(dir, "pi"),
	});

	it("refuses a bad kind, realm or pi install as misconfigured, before anything listens or is pinned", async () => {
		const pinned = Reflect.get(globalThis, STARTUP_INSTALL_KEY);
		const cases: [string[], NodeJS.ProcessEnv, string][] = [
			[["sideways"], good(), "Usage: pi-host attended|background"],
			[
				["attended"],
				{ ...good(), MYCELIUM_REALM: undefined },
				"Host needs MYCELIUM_REALM or PI_HOME_REALM",
			],
			[
				["attended"],
				{ ...good(), PI_PACKAGE_DIR: "relative" },
				"PI_PACKAGE_DIR must name",
			],
			[["attended"], good(), "is incomplete"],
		];
		for (const [argv, env, said] of cases) {
			const started = startHostProgram({
				argv,
				env,
				report: () => {},
			});
			await expect(started).rejects.toBeInstanceOf(HostMisconfigured);
			await expect(started).rejects.toThrow(said);
		}
		expect(await readdir(dir), "nothing made a socket folder").toEqual([]);
		expect(
			cases.some(([, env]) => env.PI_TRUE_COLOR !== undefined),
			"a refused host names no terminal",
		).toBe(false);
		expect(
			Reflect.get(globalThis, STARTUP_INSTALL_KEY),
			"a refused host pins no install",
		).toBe(pinned);
	});
});
