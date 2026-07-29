/**
 * Wezterm driver. Uses `wezterm cli spawn` to launch new
 * tabs and windows, and `wezterm cli split-pane` for panes.
 *
 * Available when the `wezterm` binary is on PATH. We don't
 * verify that wezterm is the active terminal: the `cli`
 * subcommand connects to the running mux over a socket, so
 * it works from anywhere as long as wezterm itself is
 * running somewhere reachable.
 */

import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import {
	type TerminalDriver,
	type TerminalLivenessCapability,
	type TerminalProbe,
	type TerminalRequest,
	type TerminalSessionHandle,
	type TerminalTypeCapability,
	terminalHandleKey,
} from "../../../terminal/types.js";
import { wrapCommandWithEnv } from "./shared.js";

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

const execFileAsync = promisify(execFile);

async function isOnPath(binary: string): Promise<boolean> {
	try {
		await execFileAsync("command", ["-v", binary]);
		return true;
	} catch {
		try {
			await execFileAsync("which", [binary]);
			return true;
		} catch {
			return false;
		}
	}
}

function buildArgs(request: TerminalRequest): string[] {
	const args: string[] = ["cli"];
	switch (request.layout) {
		case "tab":
			args.push("spawn");
			break;
		case "window":
			args.push("spawn", "--new-window");
			break;
		case "pane":
			args.push("split-pane");
			break;
	}
	if (request.cwd) args.push("--cwd", request.cwd);
	// No command means the caller wants the surface itself: let
	// wezterm start the user's own login shell, which is the only way
	// the shell's startup files run. Handing even a trivial command to
	// `-c` skips them.
	if (request.command === undefined) return args;
	// `wezterm cli` hands the command to the mux daemon,
	// which runs it in the daemon's own environment. The
	// Node-side env on `nodeSpawn` reaches only the cli
	// process itself, not the new pane, so env that must
	// reach the pane has to be wrapped into the command.
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

export const wezterm: TerminalDriver &
	TerminalLivenessCapability &
	TerminalTypeCapability = {
	id: "wezterm",
	async available() {
		return isOnPath("wezterm");
	},
	async spawn(request) {
		const args = buildArgs(request);
		// Wait for the cli to finish rather than detaching, so its
		// stdout can be read: it prints the new pane id, and without
		// that the caller has no way to name what it just created. The
		// cli returns as soon as the mux has spawned the pane, so this
		// does not wait on the pane's own lifetime.
		try {
			const { stdout } = await execFileAsync("wezterm", args);
			const pane = paneIdFromSpawn(stdout);
			if (!pane) return undefined;
			return {
				driverId: "wezterm",
				kind: "wezterm-pane",
				hostId: hostname(),
				value: pane,
				...(process.env.WEZTERM_UNIX_SOCKET
					? { scope: process.env.WEZTERM_UNIX_SOCKET }
					: {}),
			};
		} catch (error) {
			// A spawn that failed is worth reporting: the caller asked for
			// a surface and has not got one.
			throw error instanceof Error ? error : new Error(String(error));
		}
	},
	async typeInto(handle, text) {
		// --no-paste sends the text as individual keystrokes rather than
		// a bracketed paste, so the shell treats it as typed input and
		// runs it on the newline.
		await execFileAsync(
			"wezterm",
			["cli", "send-text", "--pane-id", handle.value, "--no-paste", text],
			{ env: process.env },
		);
	},
	identifyCurrent() {
		const pane = process.env.WEZTERM_PANE;
		if (!pane) return undefined;
		return {
			driverId: "wezterm",
			kind: "wezterm-pane",
			hostId: hostname(),
			scope: process.env.WEZTERM_UNIX_SOCKET,
			value: pane,
		};
	},
	async probe(handles, signal) {
		const observation = await observePanes(signal);
		return classifyWeztermPanes(handles, observation);
	},
};

/** Read the live pane set from the wezterm mux, or report it unreachable. */
async function observePanes(signal?: AbortSignal): Promise<WeztermObservation> {
	const socket = process.env.WEZTERM_UNIX_SOCKET;
	if (!socket) return { reachable: false };
	try {
		const { stdout } = await execFileAsync(
			"wezterm",
			["cli", "list", "--format", "json"],
			{ signal },
		);
		const panes = JSON.parse(stdout) as Array<{ pane_id?: unknown }>;
		const live = new Set<string>();
		for (const pane of panes) {
			if (typeof pane.pane_id === "number") live.add(String(pane.pane_id));
		}
		return {
			reachable: true,
			hostId: hostname(),
			scope: socket,
			livePaneIds: live,
		};
	} catch {
		// Mux unreachable, wezterm absent, or unparseable output: an
		// observation failure is unknown, never a false absent.
		return { reachable: false };
	}
}
