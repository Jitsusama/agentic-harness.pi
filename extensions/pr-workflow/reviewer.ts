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

import { ReviewerStreamParser } from "./reviewer-stream.js";

/** File-backed artifacts emitted by a supervised reviewer run. */
export interface ReviewerRunArtifacts {
	readonly runDir: string;
	readonly reviewerDir: string;
	readonly eventsPath: string;
	readonly stderrPath: string;
	readonly progressPath: string;
	readonly resultPath: string;
}

export { extractUsageFromPiStream } from "./reviewer-stream.js";

/** A reviewer config: identity, model, thinking level, tool palette. */
export interface CouncilReviewer {
	/** Stable id used in finding origin and result correlation. */
	readonly id: string;
	/**
	 * Pi `--model` value. Either a bare model id
	 * (`claude-opus-4-7`) or a `provider/model` pair
	 * (`anthropic/claude-opus-4-7`). The colon form
	 * `provider:model` is NOT accepted by pi's CLI; colons
	 * are reserved for the `model:thinking` shorthand.
	 */
	readonly model?: string;
	/**
	 * Pi `--thinking` value: `off`, `low`, `medium`, or
	 * `high`. Omit to inherit pi's session default.
	 */
	readonly thinkingLevel?: ReviewerThinkingLevel;
	/** Pi `--tools` palette (e.g. ["read", "grep", "bash"]). */
	readonly tools?: readonly string[];
}

/** Thinking levels accepted by pi's `--thinking` flag. */
export type ReviewerThinkingLevel = "off" | "low" | "medium" | "high";

/** Result of one pi subprocess invocation. */
export interface ReviewerVerification {
	/** Whether the reviewer called verify_output at least once. */
	readonly called: boolean;
	/** Whether the last verify_output call returned ok: true. */
	readonly ok: boolean;
	/** Stage passed to verify_output, when available. */
	readonly stage?: string;
	/** Count returned by the verifier on success. */
	readonly count?: number;
	/** Verifier warning rows, such as stringified-output coercion. */
	readonly warnings?: readonly string[];
	/** Human-readable result text from the verifier. */
	readonly message?: string;
	/** The output object from a successful verification. */
	readonly output?: unknown;
}

export interface RunPiResult {
	/** Raw stdout. Legacy runners may still return this; supervised runners should not. */
	readonly stdout?: string;
	/** Raw stderr. Legacy runners may still return this; supervised runners should prefer stderrTail. */
	readonly stderr?: string;
	readonly exitCode: number;
	/** Extracted assistant output. Present for supervised, file-backed runners. */
	readonly finalAssistantText?: string;
	/** Extracted usage. Present when the stream carried usage data. */
	readonly usage?: ReviewerUsage;
	/** Runner-level warnings from streaming, supervision or recovery. */
	readonly warnings?: readonly string[];
	/** Bounded stderr tail fit for warnings and diagnostics. */
	readonly stderrTail?: string;
	/** Result of the reviewer's verify_output calls, when observed. */
	readonly verification?: ReviewerVerification;
	/** Durable files backing this run, when available. */
	readonly artifacts?: ReviewerRunArtifacts;
}

/** One pi `--mode json` stream event. */
export type RunPiStreamEvent = Record<string, unknown>;

/** Injectable subprocess runner. */
export type RunPi = (opts: {
	readonly args: string[];
	readonly cwd: string;
	readonly runId?: string;
	readonly reviewerId?: string;
	readonly signal?: AbortSignal;
	/**
	 * Optional live-stream hook. Fires per parsed JSON
	 * event line as the subprocess emits it. Errors
	 * thrown inside the callback are swallowed so a
	 * broken observer can't kill the run.
	 */
	readonly onEvent?: (event: RunPiStreamEvent) => void;
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
	/** Durable run id used by supervised reviewer jobs. */
	readonly runId?: string;
	/**
	 * Absolute paths of sibling extensions to inject
	 * into the subagent via `--extension`. Used by the
	 * council orchestrator to load the verify-output
	 * surface (and any future parent-side helpers) so the
	 * subagent can self-validate before ending. Pi auto-
	 * discovery still applies for the user's own globals;
	 * these layer on top.
	 */
	readonly extraExtensions?: readonly string[];
	/**
	 * Live event hook forwarded to the subprocess
	 * runner. The council orchestrator uses this to
	 * translate the reviewer's per-line stream into
	 * progress updates ("reading task.go", "running
	 * bash…") so the user sees signal mid-flight instead
	 * of dead air.
	 */
	readonly onEvent?: (event: RunPiStreamEvent) => void;
}

/** Token + cost figures for one reviewer subagent run. */
export interface ReviewerUsage {
	readonly tokens: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}

/** Result of one reviewer's run. */
export interface RunReviewerResult {
	readonly reviewerId: string;
	readonly exitCode: number;
	readonly finalAssistantText: string;
	readonly stderr: string;
	readonly warnings: string[];
	/**
	 * Token + cost totals from the final assistant
	 * message_end event. `undefined` when the stream
	 * carried no usage block (older pi, fake runners).
	 */
	readonly usage?: ReviewerUsage;
	/** Result of the reviewer's verify_output calls, when observed. */
	readonly verification?: ReviewerVerification;
}

/**
 * Spawn one reviewer subagent, capture its output, and
 * extract the final assistant turn's text for downstream
 * finding parsing.
 */
export async function runReviewer(
	options: RunReviewerOptions,
): Promise<RunReviewerResult> {
	const args = composeArgs(
		options.reviewer,
		options.prompt,
		options.extraExtensions,
	);
	const result = await options.runPi({
		args,
		cwd: options.cwd,
		...(options.runId ? { runId: options.runId } : {}),
		reviewerId: options.reviewer.id,
		signal: options.signal,
		onEvent: options.onEvent,
	});

	const parsed = extractRunPiOutput(result);
	const verification = parsed.verification;
	const requiresVerification = requiresVerifyExtension(options.extraExtensions);
	const verifiedText = verification?.ok
		? verifiedOutputText(verification.output)
		: null;
	const warnings = [...parsed.warnings];
	if (verification?.warnings) {
		warnings.push(
			...verification.warnings.map(
				(warning) => `Reviewer verify_output warning: ${warning}`,
			),
		);
	}
	if (requiresVerification && verifiedText === null) {
		warnings.push(verificationFailureWarning(verification));
	}

	if (result.exitCode !== 0) {
		warnings.push(`Pi subprocess exited non-zero (exit ${result.exitCode})`);
		const stderrSnippet = summarizeStderr(parsed.stderr);
		if (stderrSnippet) {
			warnings.push(`Pi stderr: ${stderrSnippet}`);
		}
	}

	return {
		reviewerId: options.reviewer.id,
		exitCode: result.exitCode,
		finalAssistantText:
			requiresVerification && verifiedText === null
				? ""
				: (verifiedText ?? parsed.finalAssistantText),
		stderr: parsed.stderr,
		warnings,
		...(parsed.usage ? { usage: parsed.usage } : {}),
		...(verification ? { verification } : {}),
	};
}

interface ExtractedRunPiOutput {
	readonly finalAssistantText: string;
	readonly usage?: ReviewerUsage;
	readonly warnings: readonly string[];
	readonly stderr: string;
	readonly verification?: ReviewerVerification;
}

function extractRunPiOutput(result: RunPiResult): ExtractedRunPiOutput {
	if (result.finalAssistantText !== undefined) {
		return {
			finalAssistantText: result.finalAssistantText,
			...(result.usage ? { usage: result.usage } : {}),
			warnings: result.warnings ?? [],
			stderr: result.stderrTail ?? result.stderr ?? "",
			...(result.verification ? { verification: result.verification } : {}),
		};
	}
	const parser = new ReviewerStreamParser();
	parser.ingestChunk(result.stdout ?? "");
	const parsed = parser.finish();
	return {
		finalAssistantText: parsed.finalAssistantText,
		...(parsed.usage ? { usage: parsed.usage } : {}),
		warnings: [...(result.warnings ?? []), ...parsed.warnings],
		stderr: result.stderrTail ?? result.stderr ?? "",
		...(result.verification ? { verification: result.verification } : {}),
	};
}

function requiresVerifyExtension(
	extraExtensions: readonly string[] | undefined,
): boolean {
	return (extraExtensions ?? []).some((path) =>
		path.includes("pr-workflow-verify"),
	);
}

function verifiedOutputText(output: unknown): string | null {
	if (output === undefined) return null;
	return ["```json", JSON.stringify(output, null, 2), "```"].join("\n");
}

function verificationFailureWarning(
	verification: ReviewerVerification | undefined,
): string {
	if (verification === undefined || !verification.called) {
		return "Reviewer output ignored because verify_output was not called.";
	}
	const suffix = verification.message ? ` ${verification.message}` : "";
	return `Reviewer output ignored because verify_output did not return ok: true.${suffix}`;
}

const STDERR_SNIPPET_MAX = 240;

/**
 * Trim pi's stderr down to something fit for inline
 * warning display. Keeps the first non-empty line so
 * common errors like `Error: Model "..." not found.`
 * surface without dumping a full traceback at the user.
 */
function summarizeStderr(stderr: string): string {
	if (!stderr) return "";
	const lines = stderr.split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		return truncate(trimmed, STDERR_SNIPPET_MAX);
	}
	return "";
}

/**
 * Tool name registered by the `pr-workflow-verify` sibling
 * extension. Reviewer subagents call this tool to validate
 * their JSON output before ending the run. Pi's `--tools`
 * flag is an allowlist that applies to extension tools too,
 * so the dispatcher must include this in any non-empty
 * allowlist or the reviewer would be denied access to a
 * tool the prompt instructs it to use.
 */
export const VERIFY_TOOL_NAME = "verify_output";

function composeArgs(
	reviewer: CouncilReviewer,
	prompt: string,
	extraExtensions: readonly string[] | undefined,
): string[] {
	const args: string[] = ["--mode", "json", "--no-session", "-p"];
	if (reviewer.model) {
		args.push("--model", reviewer.model);
	}
	if (reviewer.thinkingLevel) {
		args.push("--thinking", reviewer.thinkingLevel);
	}
	if (reviewer.tools && reviewer.tools.length > 0) {
		args.push("--tools", buildToolsAllowlist(reviewer.tools));
	}
	if (extraExtensions) {
		for (const path of extraExtensions) {
			args.push("--extension", path);
		}
	}
	args.push(prompt);
	return args;
}

/**
 * Build the comma-separated value for pi's `--tools` flag
 * from a reviewer's configured palette. The verify tool is
 * appended (deduplicated, preserving order) so the
 * reviewer can always self-validate even when the user
 * restricts the palette.
 */
function buildToolsAllowlist(palette: readonly string[]): string {
	const tools: string[] = [];
	for (const tool of palette) {
		if (!tools.includes(tool)) {
			tools.push(tool);
		}
	}
	if (!tools.includes(VERIFY_TOOL_NAME)) {
		tools.push(VERIFY_TOOL_NAME);
	}
	return tools.join(",");
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}...`;
}
