/**
 * The host program as a unit starts it: the host's own pi loaded from
 * PI_PACKAGE_DIR and refused unless it carries every host patch, pi's
 * InteractiveMode as each conversation's screen, H1's engine over the
 * host's ownership, and the renewing gateway key, all run by runHost.
 * The engine pins the host's pi for every hosted subagent.
 * A pi runs only with PI_HOST_PROOF naming the proof that `pnpm
 * test:host` passed on its runtime, as scripts/host-prove.ts writes it.
 * What a restart can't fix (the command line, the realm, the proof, the
 * pi install)
 * is judged before anything is held or listens, and refused as such, so
 * systemd stops restarting a host that would only be refused again.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { packageConfigPath, stateDir } from "../../lib/internal/paths.ts";
import { sayLoaded } from "../../lib/internal/reload/said.ts";
import {
	createEngine,
	HOST_READS,
	type HostEngine,
	type HostPiModules,
	lackingSeams,
	loadHostPi,
} from "../engine/index.ts";
import { hostRealm } from "./address.ts";
import { gatewayKey } from "./gateway-key.ts";
import { hostProof } from "./proof.ts";
import { followWhatStarts } from "./restart.ts";
import { hostRoot } from "./rollout.ts";
import { type HostRun, hostKind, reportToJournal, runHost } from "./run.ts";
import { hostSettings } from "./settings.ts";
import { noticingInput } from "./viewer.ts";

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
 * The runtime's own tools and the viewers' terminal (HOST_READS) are
 * kept from them too: code in the host still reads them, but a newer pi
 * a command starts runs its own tools, as its PATH finds them, and
 * judges its own terminal.
 */
const HOST_ONLY = [
	"NOTIFY_SOCKET",
	"WATCHDOG_PID",
	"WATCHDOG_USEC",
	"LISTEN_FDS",
	"LISTEN_PID",
	"LISTEN_FDNAMES",
	"PI_PACKAGE_DIR",
	"PI_HOST_PROOF",
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
	for (const name of [...HOST_ONLY, ...HOST_READS]) delete base[name];
	return base;
}

/**
 * A conversation's own variables, laid over the realm's: how the session
 * it continues ran its commands (the fence, the spawner), which the
 * asker hands on, since the host's own environment sets neither. The
 * protocol lets through only those variables, each a plain word.
 */
export function conversationLaunch(request: {
	readonly env?: Readonly<Record<string, string>> | undefined;
}): Readonly<Record<string, string>> {
	return request.env ?? {};
}

/**
 * Say in the install's `loaded` folder that this process runs the
 * harness at `root`, as each pi says at its load, so pi-packages keeps
 * the version the host's own code runs from, and every version retired
 * since the host started, before any conversation has loaded one. An
 * attended host with none open said nothing on 11 November (K7's audit,
 * gap 21), so two install moves could remove the code it ran. Answers
 * the file, or nothing for a root outside an install, such as a tree.
 * Nothing takes it back: pi-packages removes it once the process ends.
 */
export function sayHostRuns(
	root: string = hostRoot(),
	pid: number = process.pid,
): string | undefined {
	return sayLoaded(root, undefined, pid);
}

/**
 * Start the host: judge its configuration, then serve until a stop
 * signal. A configuration refused rejects with HostMisconfigured before
 * anything is held, named or listening.
 */
export async function startHostProgram(
	options: HostProgramOptions,
): Promise<HostRun> {
	const { argv, env } = options;
	const report = options.report ?? reportToJournal;
	const configured = await configuration(options);
	const settings = await hostSettings(report, packageConfigPath(env));
	// A runtime built before a wanted seam still hosts; the host says what it goes without.
	if (configured.lacking) report(configured.lacking);
	sayHostRuns();
	nameViewerTerminal(env);
	configured.startTheme();
	// The screens import pi's terminal library, which binds to the host's
	// pi, so they load only once that pi is judged whole: a refused one is
	// said as a refusal, not as a module that can't be found.
	const { hostScreens, hostedModeOf } = await import("../screen/screens.ts");
	const { hostedAskerOf } = await import("../screen/startup-ask.ts");
	const screens = hostScreens({
		create: hostedModeOf(configured.interactiveMode),
		ask: hostedAskerOf(
			configured.startupQuestions.selector,
			configured.startupQuestions.mainScreen,
		),
		report,
	});
	let engine: HostEngine | undefined;
	const run = await runHost({
		argv,
		env,
		report,
		engine: async (host) => {
			engine = await createEngine({
				packageDir: configured.packageDir,
				stateDir: join(stateDir("host-engine"), host.key),
				host,
				env: conversationBase(env),
				conversationEnv: (_conversation, request) =>
					conversationLaunch(request),
				key: gatewayKey({ env }),
				screens: screens.screens,
				collectWhenQuiet: settings.collectWhenQuiet,
				report,
			});
			return engine;
		},
		// A viewer's key or resize holds the quiet collection off for a while.
		viewer: () => noticingInput(screens.viewer, () => engine?.viewed()),
		// One conversation's throw ends only it, never the host's other conversations.
		faults: process,
		contain: (sessionId, error) => screens.faulted(sessionId, error),
	});
	// The host's own code and pi move only as it restarts, so it restarts
	// itself once either would differ and nobody would notice.
	const unfollow = await followWhatStarts({
		serving: run.serving,
		// runHost answers only once its engine is made.
		background: () => engine?.background() ?? 0,
		holding: () => engine?.holding() ?? [],
		resting: () => screens.resting(),
		report,
	}).catch((error: unknown) => {
		report(error);
		return () => undefined;
	});
	run.stopped.then(unfollow, unfollow);
	return run;
}

/** Everything a restart can't change, judged before the host starts. */
async function configuration(options: HostProgramOptions): Promise<{
	packageDir: string;
	interactiveMode: unknown;
	startupQuestions: StartupQuestions;
	startTheme: () => void;
	/** What the host's pi goes without, said at start; none when it lacks no wanted seam. */
	lacking: string | undefined;
}> {
	try {
		hostKind(options.argv);
		hostRealm(options.env);
		const packageDir = hostPackageDir(options.env);
		hostProof(options.env, packageDir);
		const pi = await loadHostPi(packageDir);
		return {
			packageDir,
			interactiveMode: pi.modules.codingAgent.InteractiveMode,
			startupQuestions: startupQuestions(pi.modules),
			startTheme: themeStarter(pi.modules.codingAgent, homedir()),
			lacking:
				pi.lacking.length > 0
					? lackingSeams(packageDir, pi.lacking)
					: undefined,
		};
	} catch (error) {
		throw new HostMisconfigured(error);
	}
}

/** What pi's CLI draws its startup questions with, as the host's pi exports them. */
export interface StartupQuestions {
	/** pi's ExtensionSelectorComponent. */
	readonly selector: unknown;
	/** pi-tui's TuiMainScreen, which the selector is drawn in. */
	readonly mainScreen: unknown;
}

/**
 * The selector pi's CLI asks its startup questions with (whether to trust
 * a project folder) and the main-screen TUI it draws in, which a hosted
 * screen shows the same way. A pi lacking either is refused.
 */
export function startupQuestions(
	modules: Pick<HostPiModules, "codingAgent" | "tui">,
): StartupQuestions {
	const selector = modules.codingAgent.ExtensionSelectorComponent;
	if (typeof selector !== "function")
		throw new Error("The host's pi lacks ExtensionSelectorComponent");
	const mainScreen = modules.tui.TuiMainScreen;
	if (typeof mainScreen !== "function")
		throw new Error("The host's pi-tui lacks TuiMainScreen");
	return { selector, mainScreen };
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
