/**
 * Council progress reporter contract.
 *
 * The council fans reviewers out concurrently. Before
 * this hook, the whole batch ran in silence — the
 * Phase 1 walkthrough recorded 2m 37s of dead air with
 * no signal of which reviewer was still working or
 * whether one had crashed.
 *
 * `CouncilProgress` is a thin observer the orchestrator
 * notifies as each reviewer starts and finishes. The
 * orchestrator stays oblivious to how the observer
 * renders progress; production wires a status-line +
 * widget reporter in `council-progress-render.ts`,
 * tests use an array-backed fake.
 *
 * Every method is best-effort: errors thrown inside
 * progress callbacks are swallowed so a broken reporter
 * can't take down a live council run.
 */

import type { CouncilReviewer, ReviewerUsage } from "./reviewer.js";

/** Per-reviewer lifecycle state surfaced to the UI. */
export type CouncilProgressState =
	| "pending"
	| "running"
	| "complete"
	| "cancelled"
	| "failed";

/** Snapshot of a single reviewer's lifecycle. */
export interface CouncilProgressEntry {
	readonly reviewer: CouncilReviewer;
	readonly state: CouncilProgressState;
	/** Findings parsed from this reviewer; populated after `complete`. */
	readonly findingCount: number;
	/** Custom completion text for non-finding stages such as critique. */
	readonly completedLabel?: string;
	/** Warnings reported by the dispatcher and parser. */
	readonly warnings: readonly string[];
	/** Error message when state is `failed`. Empty otherwise. */
	readonly error: string;
	/**
	 * Short live-activity hint while `state` is
	 * `running` (e.g. "reading task.go", "running
	 * bash…"). Empty when no activity has been reported
	 * or after the reviewer settles.
	 */
	readonly activity: string;
}

/** Completed reviewer progress payload. */
export interface CouncilProgressCompletion {
	readonly reviewerId: string;
	readonly findings?: readonly unknown[];
	readonly warnings: readonly string[];
	readonly usage?: ReviewerUsage;
	readonly completedLabel?: string;
}

/** Observer notified as reviewers progress. */
export interface CouncilProgress {
	/**
	 * Called once at the start of a run with the full
	 * roster, all in `pending` state. The reporter can
	 * use this to size the widget.
	 */
	start(entries: readonly CouncilProgressEntry[]): void;

	/** A reviewer has begun dispatch (subprocess spawned). */
	reviewerStarted(reviewerId: string): void;

	/**
	 * Mid-flight activity hint. Fires when the
	 * reviewer's subagent calls a tool that's worth
	 * surfacing in the UI (file read, bash, grep). The
	 * orchestrator decides what counts; the reporter
	 * just renders the latest one.
	 */
	reviewerActivity?(reviewerId: string, activity: string): void;

	/** A reviewer has produced output (parsed successfully). */
	reviewerCompleted(
		reviewerId: string,
		output: CouncilProgressCompletion,
	): void;

	/** A reviewer was cancelled by the user. */
	reviewerCancelled?(reviewerId: string): void;

	/** A reviewer's dispatch threw. */
	reviewerFailed(reviewerId: string, error: string): void;

	/** All reviewers have settled; orchestrator is wrapping up. */
	finish(): void;
}

/**
 * Run a function while reporting to a progress observer.
 * Swallows errors thrown by observer methods so a broken
 * reporter never takes down the run; the orchestrator
 * keeps its own try/catch around the body.
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
export const NULL_PROGRESS: CouncilProgress = {
	start() {},
	reviewerStarted() {},
	reviewerActivity() {},
	reviewerCompleted() {},
	reviewerCancelled() {},
	reviewerFailed() {},
	finish() {},
};

/**
 * Translate one pi `--mode json` stream event into a
 * short activity string for the UI.
 *
 * Returns `null` for events that don't move the
 * reviewer's surface state (text deltas, message_end,
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
