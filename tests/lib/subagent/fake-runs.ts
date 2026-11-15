/**
 * The fake runners the `runReviewer` tests share.
 *
 * `runReviewer` spawns a separate pi process as a full
 * agentic harness for each council reviewer. The reviewer
 * gets its own context window, tools, and model. Output
 * is line-delimited JSON events on stdout; we extract the
 * final assistant turn's text content so the parser
 * (parse.ts) can pull findings out of it.
 *
 * The subagent-*.test.ts files beside this inject a fake
 * `runPi` that returns canned stdout, from here. They verify:
 *   - The pi CLI args composed for each reviewer config.
 *   - The cwd handed to runPi (must be the worktree path).
 *   - That the last assistant message's text is what
 *     gets surfaced.
 *   - Warnings for malformed events and non-zero exits.
 */

import { type CouncilReviewer, type ReviewerError, type ReviewerVerification, type RunPi, type RunPiResult, type RunReviewerOptions, type RunReviewerResult, runReviewer } from "../../../lib/subagent/subagent.ts";
import { at } from "../../support/at.ts";

/** The reviewer these tests run unless one says otherwise. */
export const REVIEWER: CouncilReviewer = {
	id: "council-fast",
	model: "anthropic/claude-sonnet-4-5",
	tools: ["read", "grep", "glob", "ls", "bash"],
};

/** Run the reviewer on `runPi`, in the worktree these tests name. */
export function review(
	runPi: RunPi,
	more: Partial<RunReviewerOptions> = {},
): Promise<RunReviewerResult> {
	return runReviewer({
		reviewer: REVIEWER,
		prompt: "p",
		cwd: "/tmp/wt",
		runPi,
		...more,
	});
}

/** A stream line in which the assistant ends a message saying `text`. */
export function assistantEvent(text: string): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
		},
	});
}

/** A runner that answers every call with `result`, recording each call's args and cwd. */
export function fakeRun(result: {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	finalAssistantText?: string;
	verification?: ReviewerVerification;
	error?: ReviewerError;
	state?: RunPiResult["state"];
}): { runPi: RunPi; calls: Array<{ args: string[]; cwd: string }> } {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const runPi: RunPi = async (opts) => {
		calls.push({ args: opts.args, cwd: opts.cwd });
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.exitCode ?? 0,
			...(result.finalAssistantText !== undefined
				? { finalAssistantText: result.finalAssistantText }
				: {}),
			...(result.verification ? { verification: result.verification } : {}),
			...(result.error ? { error: result.error } : {}),
			...(result.state ? { state: result.state } : {}),
		};
	};
	return { runPi, calls };
}

// Returns each queued RunPiResult on successive calls (the
// last repeats), recording the args of every call so a test
// can assert the resume dispatch shape.
/**
 * A scripted runner that records what it was asked for.
 *
 * It used to keep three fields, which left the ids a call ran under and
 * the budget it was given invisible to every assertion. Both decide
 * whether a run overwrites another's record or outlives the budget it
 * was meant to fit inside, so both are recorded.
 */
export function scriptedRun(results: RunPiResult[]): {
	runPi: RunPi;
	calls: Array<{
		args: string[];
		cwd: string;
		persistSession?: boolean;
		reviewerId?: string;
		runId?: string;
		timeoutMs?: number;
		idleTimeoutMs?: number;
		wrapUpReserveMs?: number;
		env?: Readonly<Record<string, string>>;
	}>;
} {
	const calls: Array<{
		args: string[];
		cwd: string;
		persistSession?: boolean;
		reviewerId?: string;
		runId?: string;
		timeoutMs?: number;
		idleTimeoutMs?: number;
		wrapUpReserveMs?: number;
		env?: Readonly<Record<string, string>>;
	}> = [];
	const runPi: RunPi = async (opts) => {
		calls.push({
			args: opts.args,
			cwd: opts.cwd,
			persistSession: opts.persistSession,
			reviewerId: opts.reviewerId,
			runId: opts.runId,
			timeoutMs: opts.timeoutMs,
			idleTimeoutMs: opts.idleTimeoutMs,
			wrapUpReserveMs: opts.wrapUpReserveMs,
			env: opts.env,
		});
		const index = Math.min(calls.length - 1, results.length - 1);
		return at(results, index);
	};
	return { runPi, calls };
}
