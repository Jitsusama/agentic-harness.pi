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
import { promisify } from "node:util";
import type {
	TerminalDriver,
	TerminalRequest,
} from "../../../terminal/types.js";

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
	args.push("--", "/bin/sh", "-c", request.command);
	return args;
}

export const wezterm: TerminalDriver = {
	id: "wezterm",
	async available() {
		return isOnPath("wezterm");
	},
	async spawn(request) {
		const args = buildArgs(request);
		const env: NodeJS.ProcessEnv = { ...process.env, ...(request.env ?? {}) };
		await new Promise<void>((resolve, reject) => {
			const child = nodeSpawn("wezterm", args, {
				detached: true,
				stdio: "ignore",
				env,
			});
			child.on("error", reject);
			child.on("spawn", () => {
				child.unref();
				resolve();
			});
		});
	},
};
