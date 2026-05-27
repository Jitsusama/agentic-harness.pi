/**
 * Fleet progress reporter contract.
 *
 * The `subagent` tool fans N pi processes out concurrently;
 * without live feedback the user stares at dead air. This
 * observer mirrors pr-workflow's `CouncilProgress` shape
 * without the finding-specific fields — the fleet doesn't
 * count findings, it just tracks subagent lifecycle, live
 * tool activity, and final usage.
 *
 * Production wiring (in `progress-render.ts`) pushes
 * snapshots into pi's status line and a focused prompt
 * panel; tests use an array-backed fake to assert
 * observability without driving a TUI.
 *
 * Every observer method is best-effort — errors thrown
 * inside callbacks must never take down a live fleet run.
 */

import type {
	SubagentSpec,
	SubagentUsage,
} from "../../lib/subagent/subagent.js";

/** Per-subagent lifecycle state surfaced to the UI. */
export type FleetProgressState =
	| "pending"
	| "running"
	| "complete"
	| "cancelled"
	| "failed";

/** Snapshot of a single subagent's lifecycle. */
export interface FleetProgressEntry {
	readonly spec: SubagentSpec;
	readonly state: FleetProgressState;
	/** Warnings reported by the engine or parser. */
	readonly warnings: readonly string[];
	/** Error message when state is `failed`. Empty otherwise. */
	readonly error: string;
	/**
	 * Short live-activity hint while `state` is
	 * `running` (e.g. "reading task.go", "running
	 * bash…"). Empty when no activity has been reported
	 * or after the subagent settles.
	 */
	readonly activity: string;
	/** Usage from the final message_end event, when present. */
	readonly usage?: SubagentUsage;
}

/** Completed subagent payload. */
export interface FleetProgressCompletion {
	readonly subagentId: string;
	readonly warnings: readonly string[];
	readonly usage?: SubagentUsage;
}

/** Observer notified as subagents progress. */
export interface FleetProgress {
	/**
	 * Called once at the start of a run with the full
	 * roster, all in `pending` state. The reporter can
	 * use this to size the widget.
	 */
	start(entries: readonly FleetProgressEntry[]): void;

	/** A subagent has begun dispatch (subprocess spawned). */
	subagentStarted(subagentId: string): void;

	/**
	 * Mid-flight activity hint. Fires when the subagent
	 * calls a tool worth surfacing (file read, bash,
	 * grep). The orchestrator decides what counts; the
	 * reporter just renders the latest one.
	 */
	subagentActivity?(subagentId: string, activity: string): void;

	/** A subagent has finished successfully. */
	subagentCompleted(subagentId: string, output: FleetProgressCompletion): void;

	/** A subagent was cancelled by the user. */
	subagentCancelled?(subagentId: string): void;

	/** A subagent's dispatch threw. */
	subagentFailed(subagentId: string, error: string): void;

	/** All subagents have settled; orchestrator is wrapping up. */
	finish(): void;
}

/**
 * Run an observer notification safely. Errors thrown
 * inside the callback are caught and surfaced as warnings
 * so a broken reporter never takes down the run.
 */
export function safelyNotify(
	fn: () => void,
	tag: string,
	warnings: string[],
): void {
	try {
		fn();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		warnings.push(`Progress reporter ${tag} failed: ${message}`);
	}
}

/** No-op reporter; used when the caller doesn't supply one. */
export const NULL_FLEET_PROGRESS: FleetProgress = {
	start() {},
	subagentStarted() {},
	subagentActivity() {},
	subagentCompleted() {},
	subagentCancelled() {},
	subagentFailed() {},
	finish() {},
};

/**
 * Translate one pi `--mode json` stream event into a
 * short activity string for the UI. Returns `null` for
 * events that don't move the subagent's surface state
 * (text deltas, message_end, etc.).
 *
 * The mapping is intentionally identical in spirit to
 * pr-workflow's council activity summarizer — the same
 * tool palette, the same one-line hints. Kept independent
 * so the two extensions can evolve their UIs at their own
 * pace.
 */
export function summarizeFleetActivity(event: unknown): string | null {
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
			return path ? `reading ${trim(path, 40)}` : "reading";
		}
		case "grep":
		case "Grep": {
			const pattern =
				typeof args.pattern === "string"
					? args.pattern
					: typeof args.query === "string"
						? args.query
						: "";
			return pattern ? `grep ${trim(pattern, 40)}` : "grep";
		}
		case "glob":
		case "Glob": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			return pattern ? `glob ${trim(pattern, 40)}` : "glob";
		}
		case "ls":
		case "Ls": {
			const path = typeof args.path === "string" ? args.path : "";
			return path ? `ls ${trim(path, 40)}` : "ls";
		}
		case "bash":
		case "Bash": {
			const cmd = typeof args.command === "string" ? args.command : "";
			return cmd ? `bash ${trim(cmd, 40)}` : "bash";
		}
		case "verify_output":
			return "verifying output";
		default:
			return `running ${toolName}`;
	}
}

function summarizeToolEnd(toolName: string, failed: boolean): string {
	const action = toolEndAction(toolName);
	return failed ? `${action} failed` : `finished ${action}; waiting for model`;
}

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

function trim(s: string, max: number): string {
	const clean = s.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max - 1)}…`;
}
