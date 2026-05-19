/**
 * Reviewer subagent dispatcher.
 *
 * Each council reviewer runs as a separate pi process
 * (`pi --mode json --no-session -p ...`) so it has its
 * own context window, its own model, its own tools, and
 * its own working directory (a PR worktree). That's what
 * gives reviewers the ability to investigate: read whole
 * files, grep, run tests, follow imports. A single
 * `complete()` call can't do that.
 *
 * This module is the per-reviewer dispatcher. The council
 * orchestrator (next commit) coordinates multiple
 * reviewers, hands them worktree paths and prompts, and
 * collects their outputs.
 *
 * The actual subprocess spawn is behind an injectable
 * `runPi` so unit tests can verify the args without
 * shelling out. A production-side `runPi` lives in the
 * extension entry-point and uses node:child_process.
 */

/** A reviewer config: identity, model, tool palette. */
export interface CouncilReviewer {
	/** Stable id used in finding origin and result correlation. */
	readonly id: string;
	/** Pi `--model` value (e.g. "anthropic:claude-sonnet-4.5"). */
	readonly model?: string;
	/** Pi `--tools` palette (e.g. ["read", "grep", "bash"]). */
	readonly tools?: readonly string[];
}

/** Result of one pi subprocess invocation. */
export interface RunPiResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/** Injectable subprocess runner. */
export type RunPi = (opts: {
	readonly args: string[];
	readonly cwd: string;
	readonly signal?: AbortSignal;
}) => Promise<RunPiResult>;

/** Inputs `runReviewer` needs to dispatch one pi process. */
export interface RunReviewerOptions {
	readonly reviewer: CouncilReviewer;
	/** Prompt text passed as the final positional arg. */
	readonly prompt: string;
	/** Working directory for the subprocess (worktree path). */
	readonly cwd: string;
	/** Cancellation hook; propagates to the subprocess. */
	readonly signal?: AbortSignal;
	/** Subprocess runner. Inject a fake for tests. */
	readonly runPi: RunPi;
}

/** Result of one reviewer's run. */
export interface RunReviewerResult {
	readonly reviewerId: string;
	readonly exitCode: number;
	readonly finalAssistantText: string;
	readonly stderr: string;
	readonly warnings: string[];
}

/**
 * Spawn one reviewer subagent, capture its output, and
 * extract the final assistant turn's text for downstream
 * finding parsing.
 */
export async function runReviewer(
	options: RunReviewerOptions,
): Promise<RunReviewerResult> {
	const args = composeArgs(options.reviewer, options.prompt);
	const result = await options.runPi({
		args,
		cwd: options.cwd,
		signal: options.signal,
	});

	const { finalAssistantText, warnings } = extractAssistantText(result.stdout);

	if (result.exitCode !== 0) {
		warnings.push(`Pi subprocess exited non-zero (exit ${result.exitCode})`);
	}

	return {
		reviewerId: options.reviewer.id,
		exitCode: result.exitCode,
		finalAssistantText,
		stderr: result.stderr,
		warnings,
	};
}

function composeArgs(reviewer: CouncilReviewer, prompt: string): string[] {
	const args: string[] = ["--mode", "json", "--no-session", "-p"];
	if (reviewer.model) {
		args.push("--model", reviewer.model);
	}
	if (reviewer.tools && reviewer.tools.length > 0) {
		args.push("--tools", reviewer.tools.join(","));
	}
	args.push(prompt);
	return args;
}

interface AssistantExtraction {
	finalAssistantText: string;
	warnings: string[];
}

function extractAssistantText(stdout: string): AssistantExtraction {
	const warnings: string[] = [];
	let lastAssistantText = "";
	const lines = stdout.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			warnings.push(`Malformed JSON event line: ${truncate(trimmed, 80)}`);
			continue;
		}
		const text = readAssistantText(event);
		if (text !== null) {
			lastAssistantText = text;
		}
	}
	return { finalAssistantText: lastAssistantText, warnings };
}

function readAssistantText(event: unknown): string | null {
	if (typeof event !== "object" || event === null) return null;
	const e = event as Record<string, unknown>;
	if (e.type !== "message_end") return null;
	const message = e.message;
	if (typeof message !== "object" || message === null) return null;
	const m = message as Record<string, unknown>;
	if (m.role !== "assistant") return null;
	if (!Array.isArray(m.content)) return null;
	const textParts: string[] = [];
	for (const part of m.content) {
		if (typeof part !== "object" || part === null) continue;
		const p = part as Record<string, unknown>;
		if (p.type === "text" && typeof p.text === "string") {
			textParts.push(p.text);
		}
	}
	if (textParts.length === 0) return null;
	return textParts.join("\n");
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}...`;
}
