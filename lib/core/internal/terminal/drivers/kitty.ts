/**
 * Kitty driver, through kitty's remote control (`kitty @`).
 *
 * Kitty's own words differ from the library's: what kitty calls a
 * window is a pane here, and what it calls an OS window is a window.
 * Every call names the instance it talks to by its socket, so the
 * driver can reach windows spread across several kitty processes.
 *
 * Nothing is asked of the person's kitty.conf. When the session runs in
 * a kitty with remote control on, its socket (`KITTY_LISTEN_ON`) is
 * used, and new tabs and windows join the instance the person is
 * already in. When it does not, `launch` starts a new kitty with a
 * socket of the driver's choosing and remote control switched on for
 * that instance only. That kitty is the person's: it exits when its
 * last window closes, and nothing of the driver's is left running.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type TerminalDriver,
	type TerminalLaunchCapability,
	type TerminalLivenessCapability,
	type TerminalPlatform,
	type TerminalProbe,
	type TerminalRequest,
	type TerminalSessionHandle,
	type TerminalSighting,
	type TerminalTypeCapability,
	terminalHandleKey,
} from "../../../../terminal/types.ts";
import { locateBinary } from "../binaries.ts";
import { runCli, TERMINAL_CLI_TIMEOUT_MS } from "../cli.ts";
import { PROMPT_WAIT_MS, untilPromptShown } from "./shared.ts";

/** The handle kind kitty's windows are recorded under. */
export const KITTY_HANDLE_KIND = "kitty-window";

/** How long a launched kitty may take to open its socket. */
export const KITTY_LAUNCH_TIMEOUT_MS = 10_000;

/** How often a launched kitty's socket is tried while it starts. */
const LAUNCH_POLL_MS = 100;

/** Kitty's launch type for each layout. */
const LAUNCH_TYPE = {
	window: "os-window",
	tab: "tab",
	pane: "window",
} as const;

/** The kitty layouts in which a new split sits hidden behind the active one. */
const HIDING_LAYOUTS = new Set(["stack"]);

/** What a `kitty @ ls` read observed per socket, or that it could not. */
export type KittyObservation =
	| { reachable: false }
	| {
			reachable: true;
			hostId: string;
			scope: string;
			liveWindowIds: ReadonlySet<string>;
	  };

/** One OS window in a `kitty @ ls` listing, as far as the driver reads it. */
interface KittyOsWindow {
	readonly id?: unknown;
	readonly tabs?: readonly {
		readonly id?: unknown;
		readonly layout?: unknown;
		readonly windows?: readonly { readonly id?: unknown }[];
	}[];
}

/**
 * Classify recorded kitty windows against what each socket showed. A
 * window is present or absent only when its own socket answered on the
 * same host; anything else is unknown, because a window id means
 * something only inside the instance that issued it.
 */
export function classifyKittyWindows(
	handles: readonly TerminalSessionHandle[],
	observations: ReadonlyMap<string, KittyObservation>,
): Map<string, TerminalProbe> {
	const out = new Map<string, TerminalProbe>();
	for (const handle of handles) {
		const seen = handle.scope ? observations.get(handle.scope) : undefined;
		let probe: TerminalProbe = "unknown";
		if (seen?.reachable && seen.hostId === handle.hostId) {
			probe = seen.liveWindowIds.has(handle.value) ? "present" : "absent";
		}
		out.set(terminalHandleKey(handle), probe);
	}
	return out;
}

/** Every window id a `kitty @ ls` listing holds. */
export function kittyWindowIds(listing: unknown): Set<string> {
	const ids = new Set<string>();
	for (const osWindow of asOsWindows(listing)) {
		for (const tab of osWindow.tabs ?? []) {
			for (const window of tab.windows ?? []) {
				if (typeof window.id === "number") ids.add(String(window.id));
			}
		}
	}
	return ids;
}

/** The layout of the tab holding a window, from a `kitty @ ls` listing. */
export function kittyTabLayoutOf(
	listing: unknown,
	windowId: string,
): string | undefined {
	for (const osWindow of asOsWindows(listing)) {
		for (const tab of osWindow.tabs ?? []) {
			const holds = (tab.windows ?? []).some(
				(window) => String(window.id) === windowId,
			);
			if (holds && typeof tab.layout === "string") return tab.layout;
		}
	}
	return undefined;
}

function asOsWindows(listing: unknown): readonly KittyOsWindow[] {
	return Array.isArray(listing) ? (listing as KittyOsWindow[]) : [];
}

/** The arguments to `kitty @ --to <scope>` that open a request's surface. */
export function kittyLaunchArgs(
	request: TerminalRequest,
	scope: string,
): string[] {
	const args = [
		"@",
		"--to",
		scope,
		"launch",
		`--type=${LAUNCH_TYPE[request.layout]}`,
	];
	// A tab or pane goes beside the surface it was asked to be near, or
	// beside the window remote control was run from, which kitty takes
	// to be the active one.
	if (request.near && request.layout !== "window") {
		args.push("--match", `window_id:${request.near.value}`);
	}
	if (request.cwd) args.push("--cwd", request.cwd);
	for (const [key, value] of Object.entries(request.env ?? {})) {
		args.push("--env", `${key}=${value}`);
	}
	// The title is left to the program running in the window unless the
	// caller set one, since kitty's title flags pin it for good and pi
	// names its window after its quest.
	if (request.title) args.push("--title", request.title);
	// No command starts the person's login shell, which is the only way
	// its startup files run; a command runs directly, without them.
	if (request.command !== undefined) {
		args.push("--", "/bin/sh", "-c", request.command);
	}
	return args;
}

/** The window id `kitty @ launch` prints, or undefined. */
export function kittyWindowIdFromLaunch(stdout: string): string | undefined {
	const trimmed = stdout.trim();
	return /^\d+$/.test(trimmed) ? trimmed : undefined;
}

/**
 * A socket address for a kitty this driver launches. Abstract on
 * Linux, so nothing is left on disk; a path under the temporary
 * directory on macOS, which has no abstract sockets.
 */
export function kittyLaunchSocket(
	platform: TerminalPlatform,
	id: string = randomUUID(),
): string {
	return platform === "linux"
		? `unix:@agentic-harness-kitty-${id}`
		: `unix:${join(tmpdir(), `agentic-harness-kitty-${id}.sock`)}`;
}

/** What a kitty driver can be built with. */
export interface KittyDriverOptions {
	/** How long one remote-control call may take. */
	readonly cliTimeoutMs?: number;
	/** How long a launched kitty may take to answer on its socket. */
	readonly launchTimeoutMs?: number;
	/** How long typing waits for a new shell's prompt. */
	readonly promptWaitMs?: number;
	/** Where the session's environment is read from. */
	readonly env?: () => Readonly<Record<string, string | undefined>>;
}

/** A kitty driver whose calls end at the given clocks. */
export function createKittyDriver(
	options: KittyDriverOptions = {},
): TerminalDriver &
	TerminalLivenessCapability &
	TerminalTypeCapability &
	TerminalLaunchCapability & {
		/** What the person should know before a pane is opened. */
		advise(request: TerminalRequest): Promise<string | undefined>;
	} {
	const timeout = options.cliTimeoutMs ?? TERMINAL_CLI_TIMEOUT_MS;
	const launchTimeout = options.launchTimeoutMs ?? KITTY_LAUNCH_TIMEOUT_MS;
	const promptWait = options.promptWaitMs ?? PROMPT_WAIT_MS;
	const env = options.env ?? (() => process.env);
	const binary = (): string => locateBinary("kitty", "kitty") ?? "kitty";

	const sight = (
		vars: Readonly<Record<string, string | undefined>>,
	): TerminalSighting | undefined => {
		const window = vars.KITTY_WINDOW_ID;
		if (!window) return undefined;
		const scope = vars.KITTY_LISTEN_ON;
		return {
			driverId: "kitty",
			handle: {
				driverId: "kitty",
				kind: KITTY_HANDLE_KIND,
				hostId: hostname(),
				value: window,
				...(scope ? { scope } : {}),
			},
			reachable: Boolean(scope),
			source: "environment",
		};
	};

	const list = async (scope: string, signal?: AbortSignal): Promise<unknown> =>
		JSON.parse(
			await runCli(binary(), ["@", "--to", scope, "ls"], {
				timeout,
				...(signal ? { signal } : {}),
			}),
		);

	const scopeFor = (request: TerminalRequest): string => {
		const scope = request.near?.scope ?? env().KITTY_LISTEN_ON;
		if (!scope) {
			throw new Error(
				"kitty has no remote-control socket to reach: this session is not in a kitty with remote control on, so a new kitty has to be launched instead",
			);
		}
		return scope;
	};

	return {
		id: "kitty",
		kind: "emulator",
		binary: "kitty",
		programs: ["kitty"],
		layouts: {
			window: "an OS window (launch --type=os-window)",
			tab: "a tab (launch --type=tab)",
			pane: "a kitty window in the tab (launch --type=window)",
		},
		available() {
			return locateBinary("kitty", "kitty") !== undefined;
		},
		sight,
		sightWindow(window) {
			const seen = sight({
				KITTY_WINDOW_ID: window.id,
				KITTY_LISTEN_ON: window.within,
			});
			return seen ? { ...seen, source: "holder" } : undefined;
		},
		async spawn(request) {
			const scope = scopeFor(request);
			let stdout: string;
			try {
				stdout = await runCli(binary(), kittyLaunchArgs(request, scope), {
					timeout,
				});
			} catch (error) {
				// The window a tab was to sit beside may have closed since it
				// was named; the instance is still there, so the tab goes into
				// its active window instead.
				if (!request.near || request.layout === "window") throw error;
				const { near: _gone, ...rest } = request;
				stdout = await runCli(binary(), kittyLaunchArgs(rest, scope), {
					timeout,
				});
			}
			const window = kittyWindowIdFromLaunch(stdout);
			if (!window) return undefined;
			return {
				driverId: "kitty",
				kind: KITTY_HANDLE_KIND,
				hostId: hostname(),
				scope,
				value: window,
			};
		},
		async advise(request) {
			if (request.layout !== "pane") return undefined;
			const near = request.near ?? sight(env())?.handle;
			if (!near?.scope) return undefined;
			try {
				const layout = kittyTabLayoutOf(await list(near.scope), near.value);
				if (layout && HIDING_LAYOUTS.has(layout)) {
					return `the tab uses kitty's ${layout} layout, so the new pane sits hidden behind the active one until the layout changes`;
				}
			} catch {
				// Advice is a courtesy: a kitty that will not list its tabs
				// still gets its pane, just without the warning.
			}
			return undefined;
		},
		async launch(request, context) {
			const scope = kittyLaunchSocket(context.platform);
			const args = [
				"--listen-on",
				scope,
				"-o",
				"allow_remote_control=socket-only",
				...(request.cwd ? ["--directory", request.cwd] : []),
			];
			// Detached into a session of its own, so the kitty outlives the
			// pi that launched it and belongs to the person from the start.
			const child = nodeSpawn(context.binary, args, {
				detached: true,
				stdio: "ignore",
				env: { ...context.env },
			});
			const exited = new Promise<never>((_, reject) => {
				child.once("error", reject);
				child.once("exit", (code) =>
					reject(
						new Error(
							`kitty exited with code ${code} before it opened its socket`,
						),
					),
				);
			});
			child.unref();
			const listing = await Promise.race([waitForSocket(scope), exited]);
			child.removeAllListeners();
			const [first] = [...kittyWindowIds(listing)];
			if (!first) throw new Error("the launched kitty opened no window");
			return {
				driverId: "kitty",
				kind: KITTY_HANDLE_KIND,
				hostId: hostname(),
				scope,
				value: first,
			};
		},
		async typeInto(handle, text) {
			const scope = handle.scope;
			if (!scope) {
				throw new Error(
					"this kitty window was recorded without a socket, so nothing can reach it",
				);
			}
			await untilPromptShown(
				() =>
					runCli(
						binary(),
						["@", "--to", scope, "get-text", "--match", `id:${handle.value}`],
						{ timeout },
					),
				promptWait,
			);
			// --stdin hands the text over as it is; given as an argument, kitty
			// would read Python escapes out of any backslash in it.
			await runCli(
				binary(),
				[
					"@",
					"--to",
					scope,
					"send-text",
					"--match",
					`id:${handle.value}`,
					"--stdin",
				],
				{ timeout, input: text },
			);
		},
		identifyCurrent() {
			return sight(env())?.handle;
		},
		async probe(handles, signal) {
			const scopes = new Set<string>();
			for (const handle of handles) {
				if (handle.scope && handle.hostId === hostname())
					scopes.add(handle.scope);
			}
			const observations = new Map<string, KittyObservation>();
			await Promise.all(
				[...scopes].map(async (scope) => {
					observations.set(scope, await observe(scope, signal));
				}),
			);
			return classifyKittyWindows(handles, observations);
		},
	};

	async function observe(
		scope: string,
		signal?: AbortSignal,
	): Promise<KittyObservation> {
		try {
			return {
				reachable: true,
				hostId: hostname(),
				scope,
				liveWindowIds: kittyWindowIds(await list(scope, signal)),
			};
		} catch {
			// A socket that refuses, a kitty that will not answer, or a
			// listing that will not parse: unknown, never a false absent.
			return { reachable: false };
		}
	}

	async function waitForSocket(scope: string): Promise<unknown> {
		const deadline = Date.now() + launchTimeout;
		let last: unknown;
		while (Date.now() < deadline) {
			try {
				const listing = await list(scope);
				if (kittyWindowIds(listing).size > 0) return listing;
			} catch (error) {
				// Not listening yet: a kitty takes a moment to open its socket.
				last = error;
			}
			await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
		}
		throw new Error(
			`the launched kitty did not answer on ${scope} within ${launchTimeout} ms${last instanceof Error ? ` (${last.message})` : ""}`,
		);
	}
}

/** The kitty driver, on the default clocks. */
export const kitty = createKittyDriver();
