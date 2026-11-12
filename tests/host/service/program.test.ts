/** The host program judges what it was given before it holds, pins or listens anything. */
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	conversationBase,
	conversationLaunch,
	HostMisconfigured,
	hostPackageDir,
	nameViewerTerminal,
	sayHostRuns,
	startHostProgram,
	startupQuestions,
	themeStarter,
} from "../../../host/service/program.ts";
import { PROOF_KIND, PROOF_VERSION } from "../../../host/service/proof.ts";

const STARTUP_INSTALL_KEY = Symbol.for("pi.subagent.startupPiInstall");

let dir: string;
/** Where the proofs are written, apart from dir, which a refusal leaves empty. */
let proofs: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h2-program-"));
	proofs = await mkdtemp(join(tmpdir(), "h2-program-proofs-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	await rm(proofs, { recursive: true, force: true });
});

/** A proof that pnpm test:host passed on the runtime at `runtime`. */
async function proofOf(runtime: string): Promise<string> {
	const file = join(proofs, `${runtime.replaceAll("/", "_")}.json`);
	await writeFile(
		file,
		JSON.stringify({
			kind: PROOF_KIND,
			version: PROOF_VERSION,
			runtime,
			harness: "8bd554ed03f8",
			files: 14,
			cases: 71,
			provenAt: "2026-11-10T11:00:00.000Z",
		}),
	);
	return file;
}

describe("conversationLaunch", () => {
	it("runs a conversation's commands as the session it continues ran them", () => {
		expect(
			conversationLaunch({ env: { PI_SANDBOX: "fence", PI_SPAWNER: "on" } }),
			"a fenced session's open or adopt keeps its fence in the host",
		).toEqual({ PI_SANDBOX: "fence", PI_SPAWNER: "on" });
		expect(
			conversationLaunch({}),
			"one that says nothing runs as the realm does",
		).toEqual({});
	});
});

describe("conversationBase", () => {
	it("keeps the realm's environment but not systemd's hand-over, the host's pi, its proof, its tools or its viewers' terminal", () => {
		const host: NodeJS.ProcessEnv = {
			HOME: "/home/someone",
			MYCELIUM_REALM: "work",
			SHOPIFY_PROXY_ORIGIN: "https://proxy.example",
			NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
			WATCHDOG_USEC: "1000",
			LISTEN_FDS: "1",
			PI_PACKAGE_DIR: "/nix/store/host-pi",
			PI_HOST_PROOF: "/nix/store/host-pi-proof.json",
			AI_PROXY_HEADERS_BIN: "/nix/store/host-runtime/libexec/ai-proxy-headers",
			WORKTRAIL_BIN: "/nix/store/host-runtime/libexec/worktrail",
		};
		nameViewerTerminal(host);
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

describe("sayHostRuns", () => {
	it("says in the install's loaded folder which version the host runs, as a pi does", async () => {
		const install = join(dir, "github.com", "Jitsusama", "agentic-harness.pi");
		const root = join(
			install,
			"versions",
			"01475a4f601d244bc31c11d5627e3176b1198fee",
		);
		await mkdir(root, { recursive: true });

		const file = sayHostRuns(root, 4100);

		expect(file).toBe(join(install, "loaded", "4100"));
		expect(
			JSON.parse(await readFile(join(install, "loaded", "4100"), "utf8")),
		).toEqual({
			root,
		});
	});

	it("says nothing for a host run from a tree, which no install keeps", async () => {
		const tree = join(dir, "agentic-harness.pi");
		await mkdir(tree, { recursive: true });

		expect(sayHostRuns(tree, 4100)).toBeUndefined();
		expect(await readdir(dir)).toEqual(["agentic-harness.pi"]);
	});
});

describe("startHostProgram", () => {
	it("refuses a bad kind, realm, proof or pi install as misconfigured, before anything listens or is pinned", async () => {
		const proven = await proofOf(dir);
		const good = (): NodeJS.ProcessEnv => ({
			MYCELIUM_REALM: "work",
			XDG_RUNTIME_DIR: join(dir, "run"),
			PI_PACKAGE_DIR: join(dir, "pi"),
			PI_HOST_PROOF: proven,
		});
		const pinned = Reflect.get(globalThis, STARTUP_INSTALL_KEY);
		const cases: [string[], NodeJS.ProcessEnv, string][] = [
			[
				["attended"],
				{ ...good(), PI_HOST_PROOF: undefined },
				"PI_HOST_PROOF must name the proof that pnpm test:host passed",
			],
			[
				["attended"],
				{ ...good(), PI_HOST_PROOF: await proofOf(join(proofs, "other")) },
				"The runtime's proof is for",
			],
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
