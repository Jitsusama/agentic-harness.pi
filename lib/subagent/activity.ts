/**
 * What a subagent is doing right now, in a few words.
 *
 * A fan-out that reports nothing is indistinguishable from a
 * fan-out that has hung. This turns pi's `--mode json` stream
 * events into a phrase short enough for a status line, so a
 * caller waiting on several subagents can see which are working
 * and on what.
 *
 * This lived in the PR review extension, which is where the need
 * was first felt, but nothing about it is specific to reviewing:
 * it reads pi's stream and nothing else. Its test was already
 * filed under the subagent library, which is the clearest
 * possible statement of where it belonged.
 */

/** How many characters of an argument hint to keep. */
const HINT_WIDTH = 40;

/**
 * Translate one pi `--mode json` stream event into a
 * short activity string for the UI.
 *
 * Returns `null` for events that don't move the
 * subagent's surface state (text deltas, message_end,
 * etc) so the caller can skip notification without
 * branching. Tool start events render as a verb + a
 * short argument hint scraped from `args`; tool end
 * events deliberately say the tool has finished so a
 * long model-thinking gap doesn't look like a file read
 * or verifier call is still running.
 */
export function summarizeStreamActivity(event: unknown): string | null {
	if (typeof event !== "object" || event === null) return null;
	const e = event as Record<string, unknown>;
	if (e.type === "activity" && typeof e.activity === "string") {
		return e.activity;
	}
	const toolName = typeof e.toolName === "string" ? e.toolName : "";
	if (!toolName) return null;
	if (e.type === "tool_execution_end") {
		return summarizeToolEnd(toolName, e.isError === true);
	}
	if (e.type !== "tool_execution_start") return null;
	const args =
		typeof e.args === "object" && e.args !== null
			? (e.args as Record<string, unknown>)
			: {};
	switch (toolName) {
		case "read":
		case "Read": {
			const path =
				typeof args.path === "string"
					? args.path
					: typeof args.file === "string"
						? args.file
						: "";
			return path ? `reading ${trim(path, HINT_WIDTH)}` : "reading";
		}
		case "grep":
		case "Grep": {
			const pattern =
				typeof args.pattern === "string"
					? args.pattern
					: typeof args.query === "string"
						? args.query
						: "";
			return pattern ? `grep ${trim(pattern, HINT_WIDTH)}` : "grep";
		}
		case "glob":
		case "Glob": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			return pattern ? `glob ${trim(pattern, HINT_WIDTH)}` : "glob";
		}
		case "ls":
		case "Ls": {
			const path = typeof args.path === "string" ? args.path : "";
			return path ? `ls ${trim(path, HINT_WIDTH)}` : "ls";
		}
		case "bash":
		case "Bash": {
			const cmd = typeof args.command === "string" ? args.command : "";
			return cmd ? `bash ${trim(cmd, HINT_WIDTH)}` : "bash";
		}
		case "verify_output":
			return "verifying output";
		default:
			return `running ${toolName}`;
	}
}

/**
 * A finished tool call, said so that a silent model afterwards
 * does not look like the tool is still running.
 */
function summarizeToolEnd(toolName: string, failed: boolean): string {
	const action = toolEndAction(toolName);
	return failed ? `${action} failed` : `finished ${action}; waiting for model`;
}

/** The verb to use when a tool has finished rather than started. */
function toolEndAction(toolName: string): string {
	switch (toolName) {
		case "read":
		case "Read":
			return "reading";
		case "grep":
		case "Grep":
			return "grep";
		case "glob":
		case "Glob":
			return "glob";
		case "ls":
		case "Ls":
			return "ls";
		case "bash":
		case "Bash":
			return "bash";
		case "verify_output":
			return "verifying output";
		default:
			return toolName;
	}
}

/** Collapse whitespace and cut to width, marking the cut. */
function trim(s: string, max: number): string {
	const clean = s.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max - 1)}…`;
}
