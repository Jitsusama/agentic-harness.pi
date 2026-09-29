/**
 * Tmux driver. Uses `tmux new-window` for tabs and windows
 * (tmux has no separate window concept; a new tmux "window"
 * is what we call a tab), and `tmux split-window` for panes.
 *
 * Available when both:
 *
 * - The `tmux` binary is on PATH.
 * - The current process is inside a tmux session (`TMUX`
 *   env var is set). Otherwise the new tab has nowhere to
 *   attach.
 */

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { promisify } from "node:util";
import type {
	TerminalDriver,
	TerminalRequest,
} from "../../../terminal/types.ts";
import { wrapCommandWithEnv } from "./shared.ts";

const execFileAsync = promisify(execFile);

async function tmuxOnPath(): Promise<boolean> {
	try {
		await execFileAsync("command", ["-v", "tmux"]);
		return true;
	} catch {
		try {
			await execFileAsync("which", ["tmux"]);
			return true;
		} catch {
			return false;
		}
	}
}

function buildArgs(request: TerminalRequest): string[] {
	const args: string[] = [];
	switch (request.layout) {
		case "tab":
		case "window":
			// Tmux's "window" is what other emulators call a
			// tab. There is no native multi-window concept;
			// callers asking for a window get a new tab.
			args.push("new-window");
			if (request.title) args.push("-n", request.title);
			if (request.cwd) args.push("-c", request.cwd);
			break;
		case "pane":
			args.push("split-window");
			if (request.cwd) args.push("-c", request.cwd);
			break;
	}
	// Tmux runs the spawned command in the server's
	// environment, not the calling CLI's. Wrapping the
	// command in a shell that sets env vars and execs
	// the target is portable across tmux versions and
	// avoids relying on `-e KEY=value`, which was added
	// in tmux 3.0 and not always present.
	// No command means the caller wants the surface itself, so let
	// tmux start the user's own login shell: that is the only way the
	// shell's startup files run.
	if (request.command === undefined) return args;
	args.push(wrapCommandWithEnv(request.command, request.env));
	return args;
}

/**
 * How long one tmux client call may take.
 *
 * A new-window or split-window answers as soon as the server has acted.
 * One that has not answered in ten seconds is talking to a server that
 * is wedged, and it would otherwise hold the quest call that asked, and
 * every quest call queued behind it.
 */
export const TMUX_CLI_TIMEOUT_MS = 10_000;

/** What a tmux driver can be built with. */
export interface TmuxDriverOptions {
	/** How long one client call may take. Defaults to TMUX_CLI_TIMEOUT_MS. */
	readonly cliTimeoutMs?: number;
}

/** A tmux driver whose client calls end at the given clock. */
export function createTmuxDriver(
	options: TmuxDriverOptions = {},
): TerminalDriver {
	const timeout = options.cliTimeoutMs ?? TMUX_CLI_TIMEOUT_MS;
	return {
		id: "tmux",
		async available() {
			if (!process.env.TMUX) return false;
			return tmuxOnPath();
		},
		async spawn(request) {
			const args = buildArgs(request);
			await new Promise<void>((resolve, reject) => {
				const child = nodeSpawn("tmux", args, {
					stdio: "ignore",
					timeout,
				});
				child.on("error", reject);
				child.on("exit", (code) => {
					if (code === 0) resolve();
					else if (code === null) {
						reject(new Error(`tmux did not answer within ${timeout}ms`));
					} else reject(new Error(`tmux exited with code ${code}`));
				});
			});
		},
	};
}

/** The tmux driver, on the default client clock. */
export const tmux = createTmuxDriver();
