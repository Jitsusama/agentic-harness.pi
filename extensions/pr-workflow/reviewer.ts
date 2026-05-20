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
export interface RunPiResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/** One pi `--mode json` stream event. */
export type RunPiStreamEvent = Record<string, unknown>;

/** Injectable subprocess runner. */
export type RunPi = (opts: {
	readonly args: string[];
	readonly cwd: string;
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
		signal: options.signal,
		onEvent: options.onEvent,
	});

	const { finalAssistantText, usage, warnings } = extractAssistantOutput(
		result.stdout,
	);

	if (result.exitCode !== 0) {
		warnings.push(`Pi subprocess exited non-zero (exit ${result.exitCode})`);
		const stderrSnippet = summarizeStderr(result.stderr);
		if (stderrSnippet) {
			warnings.push(`Pi stderr: ${stderrSnippet}`);
		}
	}

	return {
		reviewerId: options.reviewer.id,
		exitCode: result.exitCode,
		finalAssistantText,
		stderr: result.stderr,
		warnings,
		...(usage ? { usage } : {}),
	};
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

/**
 * Scan a pi `--mode json` stdout stream for the last
 * cumulative `usage` block emitted on an assistant
 * `message_end` event. Returns undefined when no such
 * event is present. Used by reviewer dispatchers and fix
 * dispatchers alike; both spawn pi subagents and the
 * usage shape is the same.
 */
export function extractUsageFromPiStream(
	stdout: string,
): ReviewerUsage | undefined {
	let last: ReviewerUsage | undefined;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const message = readAssistantMessage(event);
		if (message === null) continue;
		const usage = readUsage(message);
		if (usage !== undefined) {
			last = usage;
		}
	}
	return last;
}

interface AssistantExtraction {
	finalAssistantText: string;
	usage: ReviewerUsage | undefined;
	warnings: string[];
}

function extractAssistantOutput(stdout: string): AssistantExtraction {
	const warnings: string[] = [];
	let lastAssistantText = "";
	let lastUsage: ReviewerUsage | undefined;
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
		const assistantMessage = readAssistantMessage(event);
		if (assistantMessage === null) continue;
		const text = readTextContent(assistantMessage);
		if (text !== null) {
			lastAssistantText = text;
		}
		const usage = readUsage(assistantMessage);
		if (usage !== undefined) {
			lastUsage = usage;
		}
	}
	return { finalAssistantText: lastAssistantText, usage: lastUsage, warnings };
}

/**
 * Narrow a pi stream event to the assistant `message_end`
 * payload. Returns null for any other event shape so the
 * caller can skip user / tool / non-terminal events.
 */
function readAssistantMessage(event: unknown): Record<string, unknown> | null {
	if (typeof event !== "object" || event === null) return null;
	const e = event as Record<string, unknown>;
	if (e.type !== "message_end") return null;
	const message = e.message;
	if (typeof message !== "object" || message === null) return null;
	const m = message as Record<string, unknown>;
	if (m.role !== "assistant") return null;
	return m;
}

function readTextContent(message: Record<string, unknown>): string | null {
	if (!Array.isArray(message.content)) return null;
	const textParts: string[] = [];
	for (const part of message.content) {
		if (typeof part !== "object" || part === null) continue;
		const p = part as Record<string, unknown>;
		if (p.type === "text" && typeof p.text === "string") {
			textParts.push(p.text);
		}
	}
	if (textParts.length === 0) return null;
	return textParts.join("\n");
}

function readUsage(
	message: Record<string, unknown>,
): ReviewerUsage | undefined {
	const usage = message.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const u = usage as Record<string, unknown>;
	const costRaw = u.cost;
	const cost =
		typeof costRaw === "object" && costRaw !== null
			? (costRaw as Record<string, unknown>)
			: {};
	return {
		tokens: {
			input: readNumber(u.input),
			output: readNumber(u.output),
			cacheRead: readNumber(u.cacheRead),
			cacheWrite: readNumber(u.cacheWrite),
			total: readNumber(u.totalTokens),
		},
		cost: {
			input: readNumber(cost.input),
			output: readNumber(cost.output),
			cacheRead: readNumber(cost.cacheRead),
			cacheWrite: readNumber(cost.cacheWrite),
			total: readNumber(cost.total),
		},
	};
}

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}...`;
}
