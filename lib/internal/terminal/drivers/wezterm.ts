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

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import type {
	TerminalDriver,
	TerminalLivenessCapability,
	TerminalProbe,
	TerminalRequest,
	TerminalSessionHandle,
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
		out.set(handle.value, classifyOne(handle, observation));
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
	// `wezterm cli` hands the command to the mux daemon,
	// which runs it in the daemon's own environment. The
	// Node-side env on `nodeSpawn` reaches only the cli
	// process itself, not the new pane, so env that must
	// reach the pane has to be wrapped into the command.
	const command = wrapCommandWithEnv(request.command, request.env);
	args.push("--", "/bin/sh", "-c", command);
	return args;
}

export const wezterm: TerminalDriver & TerminalLivenessCapability = {
	id: "wezterm",
	async available() {
		return isOnPath("wezterm");
	},
	async spawn(request) {
		const args = buildArgs(request);
		await new Promise<void>((resolve, reject) => {
			const child = nodeSpawn("wezterm", args, {
				detached: true,
				stdio: "ignore",
			});
			child.on("error", reject);
			child.on("spawn", () => {
				child.unref();
				resolve();
			});
		});
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
	async probe(handles) {
		const observation = await observePanes();
		return classifyWeztermPanes(handles, observation);
	},
};

/** Read the live pane set from the wezterm mux, or report it unreachable. */
async function observePanes(): Promise<WeztermObservation> {
	const socket = process.env.WEZTERM_UNIX_SOCKET;
	if (!socket) return { reachable: false };
	try {
		const { stdout } = await execFileAsync("wezterm", [
			"cli",
			"list",
			"--format",
			"json",
		]);
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
