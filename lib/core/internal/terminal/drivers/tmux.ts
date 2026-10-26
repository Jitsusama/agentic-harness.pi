/**
 * Tmux driver.
 *
 * Tmux's own words differ from the library's: what tmux calls a window
 * is a tab here. Tmux is a multiplexer, so it opens tabs and panes
 * inside the terminal that shows it and cannot make a desktop window;
 * a window asked for inside tmux goes to the terminal outside it.
 *
 * Every call names its server by socket path (`-S`), taken from the
 * `TMUX` variable a tmux pane carries, so a recorded pane can be
 * probed through its own server whichever tmux the reader is in.
 */

import { hostname } from "node:os";
import {
	type TerminalDriver,
	type TerminalLivenessCapability,
	type TerminalProbe,
	type TerminalRequest,
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

/** The handle kind tmux's panes are recorded under. */
export const TMUX_HANDLE_KIND = "tmux-pane";

/** The format that makes tmux print the pane it created. */
const PRINT_PANE = ["-P", "-F", "#{pane_id}"];

/** The server socket a `TMUX` value names, which is its first field. */
export function tmuxSocketOf(value: string | undefined): string | undefined {
	const socket = value?.split(",")[0];
	return socket ? socket : undefined;
}

/**
 * The arguments, after `-S <socket>`, that open a request's surface.
 * `nearWindow` is the tmux window holding `request.near`, which a new
 * tmux window is placed after: `new-window` will not take a pane as
 * its target, so the caller looks the window up first.
 */
export function tmuxSpawnArgs(
	request: TerminalRequest,
	nearWindow?: string,
): string[] {
	const args =
		request.layout === "pane"
			? ["split-window", ...PRINT_PANE]
			: ["new-window", ...PRINT_PANE];
	if (request.layout === "pane" && request.near) {
		args.push("-t", request.near.value);
	} else if (nearWindow) {
		args.push("-a", "-t", nearWindow);
	}
	if (request.layout !== "pane" && request.title)
		args.push("-n", request.title);
	if (request.cwd) args.push("-c", request.cwd);
	// No command means the caller wants the surface itself, so tmux
	// starts the person's own login shell: the only way its startup
	// files run. Tmux runs a command in the server's environment, so
	// variables meant for it travel inside the command, which avoids
	// `-e`, added only in tmux 3.0.
	if (request.command === undefined) return args;
	args.push(wrapCommandWithEnv(request.command, request.env));
	return args;
}

/** The pane id tmux printed for a new surface, or undefined. */
export function tmuxPaneIdFromSpawn(stdout: string): string | undefined {
	const trimmed = stdout.trim();
	return /^%\d+$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The `send-keys` calls that type `text` into a pane, as literal text
 * with an Enter for each newline, so the shell runs each line as typed
 * rather than receiving a paste.
 */
export function tmuxTypeCalls(pane: string, text: string): string[][] {
	const calls: string[][] = [];
	const lines = text.split("\n");
	lines.forEach((line, index) => {
		if (line) calls.push(["send-keys", "-t", pane, "-l", "--", line]);
		if (index < lines.length - 1)
			calls.push(["send-keys", "-t", pane, "Enter"]);
	});
	return calls;
}

/** What a tmux driver can be built with. */
export interface TmuxDriverOptions {
	/** How long one tmux call may take. */
	readonly cliTimeoutMs?: number;
	/** How long typing waits for a new shell's prompt. */
	readonly promptWaitMs?: number;
	/** Where the session's environment is read from. */
	readonly env?: () => Readonly<Record<string, string | undefined>>;
}

/** A tmux driver whose calls end at the given clock. */
export function createTmuxDriver(
	options: TmuxDriverOptions = {},
): TerminalDriver & TerminalLivenessCapability & TerminalTypeCapability {
	const timeout = options.cliTimeoutMs ?? TERMINAL_CLI_TIMEOUT_MS;
	const promptWait = options.promptWaitMs ?? PROMPT_WAIT_MS;
	const env = options.env ?? (() => process.env);
	const binary = (): string => locateBinary("tmux", "tmux") ?? "tmux";
	const run = (socket: string | undefined, args: string[]) =>
		runCli(binary(), socket ? ["-S", socket, ...args] : args, { timeout });

	const sight = (
		vars: Readonly<Record<string, string | undefined>>,
	): TerminalSighting | undefined => {
		const socket = tmuxSocketOf(vars.TMUX);
		if (!socket) return undefined;
		const pane = vars.TMUX_PANE;
		return {
			driverId: "tmux",
			...(pane
				? {
						handle: {
							driverId: "tmux",
							kind: TMUX_HANDLE_KIND,
							hostId: hostname(),
							scope: socket,
							value: pane,
						},
					}
				: {}),
			reachable: true,
			source: "environment",
		};
	};

	return {
		id: "tmux",
		kind: "multiplexer",
		binary: "tmux",
		programs: ["tmux"],
		layouts: {
			tab: "a tmux window (new-window)",
			pane: "a tmux pane (split-window)",
		},
		available() {
			return locateBinary("tmux", "tmux") !== undefined;
		},
		sight,
		async spawn(request) {
			const socket = request.near?.scope ?? tmuxSocketOf(env().TMUX);
			if (!socket) {
				throw new Error(
					"tmux has no server to open into: this session is not inside tmux",
				);
			}
			const nearWindow =
				request.near && request.layout !== "pane"
					? (
							await run(socket, [
								"display-message",
								"-p",
								"-t",
								request.near.value,
								"#{window_id}",
							])
						).trim() || undefined
					: undefined;
			const pane = tmuxPaneIdFromSpawn(
				await run(socket, tmuxSpawnArgs(request, nearWindow)),
			);
			if (!pane) return undefined;
			return {
				driverId: "tmux",
				kind: TMUX_HANDLE_KIND,
				hostId: hostname(),
				scope: socket,
				value: pane,
			};
		},
		async typeInto(handle, text) {
			await untilPromptShown(
				() => run(handle.scope, ["capture-pane", "-p", "-t", handle.value]),
				promptWait,
			);
			for (const call of tmuxTypeCalls(handle.value, text)) {
				await run(handle.scope, call);
			}
		},
		identifyCurrent() {
			return sight(env())?.handle;
		},
		async probe(handles, signal) {
			const sockets = new Set<string>();
			for (const handle of handles) {
				if (handle.scope && handle.hostId === hostname())
					sockets.add(handle.scope);
			}
			const live = new Map<string, Set<string> | undefined>();
			await Promise.all(
				[...sockets].map(async (socket) => {
					if (signal?.aborted) return live.set(socket, undefined);
					try {
						const stdout = await run(socket, [
							"list-panes",
							"-a",
							"-F",
							"#{pane_id}",
						]);
						live.set(
							socket,
							new Set(
								stdout
									.split("\n")
									.map((line) => line.trim())
									.filter(Boolean),
							),
						);
					} catch {
						// A server that has gone or will not answer says nothing
						// about its panes: unknown, never a false absent.
						live.set(socket, undefined);
					}
				}),
			);
			const out = new Map<string, TerminalProbe>();
			for (const handle of handles) {
				const panes =
					handle.scope && handle.hostId === hostname()
						? live.get(handle.scope)
						: undefined;
				out.set(
					terminalHandleKey(handle),
					panes === undefined
						? "unknown"
						: panes.has(handle.value)
							? "present"
							: "absent",
				);
			}
			return out;
		},
	};
}

/** The tmux driver, on the default clock. */
export const tmux = createTmuxDriver();
