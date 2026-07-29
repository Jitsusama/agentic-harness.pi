/**
 * Fallback driver. Available everywhere; "spawns" by
 * printing the request to stderr so the user can dispatch
 * it themselves. Used when no real driver is available
 * (headless CI, unknown terminal, etc.).
 */

import type {
	TerminalDriver,
	TerminalRequest,
} from "../../../terminal/types.js";

function formatRequest(request: TerminalRequest): string {
	const parts: string[] = [];
	parts.push(`# terminal-fallback: would have opened ${request.layout}`);
	if (request.cwd) parts.push(`# cwd: ${request.cwd}`);
	if (request.title) parts.push(`# title: ${request.title}`);
	if (request.env) {
		for (const [k, v] of Object.entries(request.env)) parts.push(`${k}=${v}`);
	}
	// No command means the caller wanted a bare login shell. Say so,
	// rather than printing an empty line where a command would be.
	parts.push(request.command ?? "# (a login shell, no command)");
	return parts.join("\n");
}

export const fallback: TerminalDriver = {
	id: "fallback",
	available() {
		return true;
	},
	async spawn(request) {
		process.stderr.write(`${formatRequest(request)}\n`);
	},
};
