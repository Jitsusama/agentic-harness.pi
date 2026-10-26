/**
 * Wezterm driver, through `wezterm cli`.
 *
 * Every call names the instance it talks to by its socket, passed as
 * `WEZTERM_UNIX_SOCKET`, and runs with `--no-auto-start`: without it a
 * cli that finds no running wezterm quietly starts a headless mux, and
 * the pane it opens there is one nobody can see.
 *
 * When the session runs in wezterm its socket is used. When it does
 * not, `launch` starts a new wezterm with `wezterm start` and finds the
 * socket the new instance opened, so its first window is under control
 * from the start. That wezterm is the person's: it exits when its last
 * window closes.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
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
import {
	PROMPT_WAIT_MS,
	untilPromptShown,
	wrapCommandWithEnv,
} from "./shared.ts";

/** The handle kind wezterm's panes are recorded under. */
export const WEZTERM_HANDLE_KIND = "wezterm-pane";

/**
 * How long one `wezterm cli` call may take. Kept under its old name
 * because consumers already import it.
 */
export const WEZTERM_CLI_TIMEOUT_MS = TERMINAL_CLI_TIMEOUT_MS;

/** How long a launched wezterm may take to open its socket. */
export const WEZTERM_LAUNCH_TIMEOUT_MS = 10_000;

/** How often the socket directory is read while a launch starts. */
const LAUNCH_POLL_MS = 100;

/** The prefix of the socket a wezterm GUI instance opens. */
const GUI_SOCKET_PREFIX = "gui-sock-";

/** What a `wezterm cli list` read observed, or that it could not read. */
export type WeztermObservation =
	| { reachable: false }
	| {
			reachable: true;
			hostId: string;
			scope: string;
			livePaneIds: ReadonlySet<string>;
	  };

/**
 * Classify each recorded pane handle against a live observation. A
 * pane is present or absent only when the observation is reachable
 * and the handle's host and scope match the observed mux; otherwise
 * the honest answer is unknown, because a pane id is meaningful only
 * within the socket and host that issued it.
 */
export function classifyWeztermPanes(
	handles: readonly TerminalSessionHandle[],
	observation: WeztermObservation,
): Map<string, TerminalProbe> {
	const out = new Map<string, TerminalProbe>();
	for (const handle of handles) {
		out.set(terminalHandleKey(handle), classifyOne(handle, observation));
	}
	return out;
}

function classifyOne(
	handle: TerminalSessionHandle,
	observation: WeztermObservation,
): TerminalProbe {
	if (!observation.reachable) return "unknown";
	if (handle.hostId !== observation.hostId) return "unknown";
	if (!handle.scope || handle.scope !== observation.scope) return "unknown";
	return observation.livePaneIds.has(handle.value) ? "present" : "absent";
}

/** The pane ids a `wezterm cli list --format json` listing holds. */
export function weztermPaneIds(listing: unknown): Set<string> {
	const ids = new Set<string>();
	if (!Array.isArray(listing)) return ids;
	for (const pane of listing as { pane_id?: unknown }[]) {
		if (typeof pane.pane_id === "number") ids.add(String(pane.pane_id));
	}
	return ids;
}

/** The `wezterm cli` arguments that open a request's surface. */
export function weztermSpawnArgs(request: TerminalRequest): string[] {
	const args: string[] = ["cli", "--no-auto-start"];
	switch (request.layout) {
		case "tab":
			args.push("spawn");
			if (request.near) args.push("--pane-id", request.near.value);
			break;
		case "window":
			args.push("spawn", "--new-window");
			break;
		case "pane":
			args.push("split-pane");
			if (request.near) args.push("--pane-id", request.near.value);
			break;
	}
	if (request.cwd) args.push("--cwd", request.cwd);
	// No command means the caller wants the surface itself: let
	// wezterm start the user's own login shell, which is the only way
	// the shell's startup files run. Handing even a trivial command to
	// `-c` skips them.
	if (request.command === undefined) return args;
	// The cli hands the command to the running wezterm, which runs it
	// in its own environment, so variables meant for it travel inside
	// the command.
	const command = wrapCommandWithEnv(request.command, request.env);
	args.push("--", "/bin/sh", "-c", command);
	return args;
}

/**
 * The pane id `wezterm cli spawn` prints, or undefined when the
 * output is not one. The cli prints the new pane id on stdout,
 * which is the only reliable way to name what was just created.
 */
export function paneIdFromSpawn(stdout: string): string | undefined {
	const trimmed = stdout.trim();
	return /^\d+$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Where a wezterm GUI instance opens its socket: the runtime
 * directory on Linux, falling back to the data directory wezterm
 * uses when there is none, and the data directory on macOS.
 */
export function weztermSocketDir(
	platform: TerminalPlatform,
	env: Readonly<Record<string, string | undefined>>,
	home: string = homedir(),
): string {
	const runtime = env.XDG_RUNTIME_DIR;
	if (platform === "linux" && runtime) return join(runtime, "wezterm");
	return join(home, ".local", "share", "wezterm");
}

function guiSockets(dir: string): Set<string> {
	try {
		return new Set(
			readdirSync(dir).filter((name) => name.startsWith(GUI_SOCKET_PREFIX)),
		);
	} catch {
		// No directory yet means no wezterm has run: nothing to list.
		return new Set();
	}
}

/** What a wezterm driver can be built with. */
export interface WeztermDriverOptions {
	/** How long one cli call may take. Defaults to WEZTERM_CLI_TIMEOUT_MS. */
	readonly cliTimeoutMs?: number;
	/** How long a launched wezterm may take to answer on its socket. */
	readonly launchTimeoutMs?: number;
	/** How long typing waits for a new shell's prompt. */
	readonly promptWaitMs?: number;
	/** Where the session's environment is read from. */
	readonly env?: () => Readonly<Record<string, string | undefined>>;
}

/** A wezterm driver whose cli calls end at the given clock. */
export function createWeztermDriver(
	options: WeztermDriverOptions = {},
): TerminalDriver &
	TerminalLivenessCapability &
	TerminalTypeCapability &
	TerminalLaunchCapability {
	const timeout = options.cliTimeoutMs ?? WEZTERM_CLI_TIMEOUT_MS;
	const launchTimeout = options.launchTimeoutMs ?? WEZTERM_LAUNCH_TIMEOUT_MS;
	const promptWait = options.promptWaitMs ?? PROMPT_WAIT_MS;
	const env = options.env ?? (() => process.env);
	const binary = (): string => locateBinary("wezterm", "wezterm") ?? "wezterm";
	const cli = (
		scope: string | undefined,
		args: string[],
		signal?: AbortSignal,
	): Promise<string> =>
		runCli(binary(), args, {
			timeout,
			...(signal ? { signal } : {}),
			env: {
				...process.env,
				...(scope ? { WEZTERM_UNIX_SOCKET: scope } : {}),
			},
		});
	const list = async (scope: string, signal?: AbortSignal): Promise<unknown> =>
		JSON.parse(
			await cli(
				scope,
				["cli", "--no-auto-start", "list", "--format", "json"],
				signal,
			),
		);

	const sight = (
		vars: Readonly<Record<string, string | undefined>>,
	): TerminalSighting | undefined => {
		const pane = vars.WEZTERM_PANE;
		if (!pane) return undefined;
		const scope = vars.WEZTERM_UNIX_SOCKET;
		return {
			driverId: "wezterm",
			handle: {
				driverId: "wezterm",
				kind: WEZTERM_HANDLE_KIND,
				hostId: hostname(),
				value: pane,
				...(scope ? { scope } : {}),
			},
			reachable: Boolean(scope),
			source: "environment",
		};
	};

	return {
		id: "wezterm",
		kind: "emulator",
		binary: "wezterm",
		programs: ["wezterm-gui", "wezterm", "wezterm-mux-server"],
		layouts: {
			window: "a window (cli spawn --new-window)",
			tab: "a tab (cli spawn)",
			pane: "a pane (cli split-pane)",
		},
		available() {
			return locateBinary("wezterm", "wezterm") !== undefined;
		},
		sight,
		async spawn(request) {
			const scope = request.near?.scope ?? env().WEZTERM_UNIX_SOCKET;
			// Wait for the cli to finish rather than detaching, so its
			// stdout can be read: it prints the new pane id, and without
			// that the caller has no way to name what it just created. The
			// cli returns as soon as the mux has spawned the pane, so this
			// does not wait on the pane's own lifetime.
			const pane = paneIdFromSpawn(await cli(scope, weztermSpawnArgs(request)));
			if (!pane) return undefined;
			return {
				driverId: "wezterm",
				kind: WEZTERM_HANDLE_KIND,
				hostId: hostname(),
				value: pane,
				...(scope ? { scope } : {}),
			};
		},
		async launch(request, context) {
			const dir = weztermSocketDir(context.platform, context.env);
			const before = guiSockets(dir);
			const child = nodeSpawn(
				context.binary,
				[
					"start",
					"--always-new-process",
					...(request.cwd ? ["--cwd", request.cwd] : []),
				],
				{ detached: true, stdio: "ignore", env: { ...context.env } },
			);
			let failure: Error | undefined;
			child.once("error", (error) => {
				failure = error;
			});
			child.once("exit", (code) => {
				failure = new Error(
					`wezterm exited with code ${code} before it opened its socket`,
				);
			});
			child.unref();
			// On Linux `wezterm start` becomes the GUI and opens a socket
			// named by its own pid; elsewhere it may hand off to a GUI
			// process, so any socket that was not there before will do.
			const own = `${GUI_SOCKET_PREFIX}${child.pid}`;
			const deadline = Date.now() + launchTimeout;
			while (Date.now() < deadline && !failure) {
				const fresh = [...guiSockets(dir)].filter((name) => !before.has(name));
				const name = fresh.includes(own) ? own : fresh[0];
				if (name) {
					const scope = join(dir, name);
					try {
						const [first] = [...weztermPaneIds(await list(scope))];
						if (first) {
							child.removeAllListeners();
							return {
								driverId: "wezterm",
								kind: WEZTERM_HANDLE_KIND,
								hostId: hostname(),
								scope,
								value: first,
							};
						}
					} catch {
						// The socket exists before it answers; try again shortly.
					}
				}
				await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
			}
			child.removeAllListeners();
			throw (
				failure ??
				new Error(
					`the launched wezterm did not answer within ${launchTimeout} ms`,
				)
			);
		},
		async typeInto(handle, text) {
			await untilPromptShown(
				() =>
					cli(handle.scope, [
						"cli",
						"--no-auto-start",
						"get-text",
						"--pane-id",
						handle.value,
					]),
				promptWait,
			);
			// --no-paste sends the text as individual keystrokes rather than
			// a bracketed paste, so the shell treats it as typed input and
			// runs it on the newline.
			await cli(handle.scope, [
				"cli",
				"--no-auto-start",
				"send-text",
				"--pane-id",
				handle.value,
				"--no-paste",
				text,
			]);
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
			const out = new Map<string, TerminalProbe>();
			for (const handle of handles)
				out.set(terminalHandleKey(handle), "unknown");
			await Promise.all(
				[...scopes].map(async (scope) => {
					const observation = await observe(scope, signal);
					const mine = handles.filter((handle) => handle.scope === scope);
					for (const [key, probe] of classifyWeztermPanes(mine, observation)) {
						out.set(key, probe);
					}
				}),
			);
			return out;
		},
	};

	async function observe(
		scope: string,
		signal?: AbortSignal,
	): Promise<WeztermObservation> {
		try {
			return {
				reachable: true,
				hostId: hostname(),
				scope,
				livePaneIds: weztermPaneIds(await list(scope, signal)),
			};
		} catch {
			// Mux unreachable, wezterm absent, or unparseable output: an
			// observation failure is unknown, never a false absent.
			return { reachable: false };
		}
	}
}

/** The wezterm driver, on the default cli clock. */
export const wezterm = createWeztermDriver();
