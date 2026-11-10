/**
 * The host program as a unit starts it: the host's own pi loaded from
 * PI_PACKAGE_DIR and refused unless it carries every host patch, pi's
 * InteractiveMode as each conversation's screen, H1's engine over the
 * host's ownership, and the renewing gateway key, all run by runHost.
 * What a restart can't fix (the command line, the realm, the pi install)
 * is judged before anything is held or listens, and refused as such, so
 * systemd stops restarting a host that would only be refused again.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { stateDir } from "../../lib/internal/paths.ts";
import type { PiInstall } from "../../lib/subagent/install.ts";
import { createEngine, loadHostPi } from "../engine/index.ts";
import { hostRealm } from "./address.ts";
import { gatewayKey } from "./gateway-key.ts";
import { type HostRun, hostKind, reportToJournal, runHost } from "./run.ts";

/**
 * The exit status of a host refused for its configuration, EX_CONFIG from
 * sysexits.h. A unit names it in RestartPreventExitStatus, so a host whose
 * pi lacks a patch waits for a fix rather than restarting every few seconds.
 */
export const EXIT_MISCONFIGURED = 78;

/**
 * Variables the host process needs and no conversation should see:
 * systemd's notify, watchdog and socket hand-over, which a tool's child
 * would otherwise answer for the host, and the host's own pi install,
 * which would point an ordinary pi a tool starts at the patched one.
 */
const HOST_ONLY = [
	"NOTIFY_SOCKET",
	"WATCHDOG_PID",
	"WATCHDOG_USEC",
	"LISTEN_FDS",
	"LISTEN_PID",
	"LISTEN_FDNAMES",
	"PI_PACKAGE_DIR",
] as const;

/**
 * What pi's terminal library should take every hosted screen's terminal
 * to be. A viewer is admitted only as kitty, but pi-tui judges the
 * terminal from process.env, where a host has no KITTY_WINDOW_ID, and
 * keeps its first answer for the whole process: the theme asks first, as
 * it starts. A unit that sets one of these keeps its own value.
 */
const VIEWER_TERMINAL = {
	PI_IMAGE_PROTOCOL: "kitty",
	PI_TRUE_COLOR: "1",
	PI_HYPERLINKS: "1",
} as const;

/** The key pi's subagent library reads the parent's install from. */
const STARTUP_INSTALL_KEY = Symbol.for("pi.subagent.startupPiInstall");

/** A host refused for what it was given, which no restart changes. */
export class HostMisconfigured extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "HostMisconfigured";
	}
}

/** What the host program is started with. */
export interface HostProgramOptions {
	/** The command line after the program: the host's kind. */
	readonly argv: readonly string[];
	/**
	 * The environment the unit gave the process, process.env itself when
	 * run: the viewers' terminal is named in it before the theme starts.
	 */
	readonly env: NodeJS.ProcessEnv;
	/** The node running the host, which its subagents run on too. */
	readonly execPath: string;
	/** Where errors go; the journal by default. */
	readonly report?: (error: unknown) => void;
}

/** The host's pi install, as an absolute PI_PACKAGE_DIR names it. */
export function hostPackageDir(env: NodeJS.ProcessEnv): string {
	const dir = env.PI_PACKAGE_DIR;
	if (!(dir && isAbsolute(dir))) {
		throw new Error(
			"PI_PACKAGE_DIR must name the host's pi install as an absolute path",
		);
	}
	return dir;
}

/**
 * Name the viewers' kitty terminal in the host's environment where the
 * unit names none, so the theme and every conversation after it draw
 * for the terminal a viewer is.
 */
export function nameViewerTerminal(env: NodeJS.ProcessEnv): void {
	for (const [name, value] of Object.entries(VIEWER_TERMINAL))
		env[name] ??= value;
}

/** The environment every conversation starts from: the host's, less what only the host may see. */
export function conversationBase(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const base = { ...env };
	for (const name of HOST_ONLY) delete base[name];
	return base;
}

/** The install a hosted conversation's subagents run: the host's pi on the host's node. */
export function hostInstall(packageDir: string, node: string): PiInstall {
	return {
		node,
		entry: join(packageDir, "dist", "bundle", "cli.js"),
		packageDir,
	};
}

/**
 * Start the host: judge its configuration, then serve until a stop
 * signal. A configuration refused rejects with HostMisconfigured before
 * anything is held, pinned or listening.
 */
export async function startHostProgram(
	options: HostProgramOptions,
): Promise<HostRun> {
	const { argv, env } = options;
	const report = options.report ?? reportToJournal;
	const configured = await configuration(options);
	pinStartupInstall(hostInstall(configured.packageDir, options.execPath));
	nameViewerTerminal(env);
	configured.startTheme();
	// The screens import pi's terminal library, which binds to the host's
	// pi, so they load only once that pi is judged whole: a refused one is
	// said as a refusal, not as a module that can't be found.
	const { hostScreens, hostedModeOf } = await import("../screen/screens.ts");
	const screens = hostScreens({
		create: hostedModeOf(configured.interactiveMode),
		report,
	});
	return runHost({
		argv,
		env,
		report,
		engine: (host) =>
			createEngine({
				packageDir: configured.packageDir,
				stateDir: join(stateDir("host-engine"), host.key),
				host,
				env: conversationBase(env),
				key: gatewayKey({ env }),
				screens: screens.screens,
				report,
			}),
		viewer: () => screens.viewer,
	});
}

/** Everything a restart can't change, judged before the host starts. */
async function configuration(options: HostProgramOptions): Promise<{
	packageDir: string;
	interactiveMode: unknown;
	startTheme: () => void;
}> {
	try {
		hostKind(options.argv);
		hostRealm(options.env);
		const packageDir = hostPackageDir(options.env);
		const pi = await loadHostPi(packageDir);
		return {
			packageDir,
			interactiveMode: pi.modules.codingAgent.InteractiveMode,
			startTheme: themeStarter(pi.modules.codingAgent, homedir()),
		};
	} catch (error) {
		throw new HostMisconfigured(error);
	}
}

/**
 * What starts pi's theme as pi's own main does before any screen: the
 * one the person's settings name, read from pi's agent folder, without
 * the watcher. Every hosted screen draws with it, and InteractiveMode
 * fails without one. A pi lacking what this needs is refused.
 */
export function themeStarter(
	codingAgent: Readonly<Record<string, unknown>>,
	cwd: string,
): () => void {
	const { initTheme, SettingsManager, getAgentDir } = codingAgent;
	const create =
		typeof SettingsManager === "function"
			? Reflect.get(SettingsManager, "create")
			: undefined;
	if (
		!(
			typeof initTheme === "function" &&
			typeof create === "function" &&
			typeof getAgentDir === "function"
		)
	) {
		throw new Error(
			"The host's pi lacks initTheme, SettingsManager or getAgentDir",
		);
	}
	return () => {
		const settings: unknown = Reflect.apply(create, SettingsManager, [
			cwd,
			Reflect.apply(getAgentDir, undefined, []),
		]);
		const getTheme =
			typeof settings === "object" && settings !== null
				? Reflect.get(settings, "getTheme")
				: undefined;
		const theme: unknown =
			typeof getTheme === "function"
				? Reflect.apply(getTheme, settings, [])
				: undefined;
		Reflect.apply(initTheme, undefined, [
			typeof theme === "string" ? theme : undefined,
			false,
		]);
	};
}

/**
 * Pin the install pi's subagent library hands every hosted subagent. A
 * hosted conversation can't read it from its own process, which is the
 * host's, so the host names it once, before any extension loads.
 */
function pinStartupInstall(install: PiInstall): void {
	Reflect.set(globalThis, STARTUP_INSTALL_KEY, install);
}
