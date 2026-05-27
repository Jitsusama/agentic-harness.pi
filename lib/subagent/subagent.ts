/**
 * Subagent dispatcher.
 *
 * Each subagent runs as a separate pi process
 * (`pi --mode json --no-session -p ...`) so it has its
 * own context window, its own model, its own tools, and
 * its own working directory. That's what gives subagents
 * the ability to investigate: read whole files, grep, run
 * tests, follow imports. A single `complete()` call can't
 * do that.
 *
 * This module is the per-subagent dispatcher. Higher-level
 * orchestrators (the pr-workflow council, the
 * subagent-workflow tool) compose multiple subagents,
 * feed them prompts plus working directories and collect
 * their outputs.
 *
 * The actual subprocess spawn is behind an injectable
 * `runPi` so unit tests can verify the args without
 * shelling out. Production callers compose one of the
 * `runpi/*` runners (spawn for fire-and-forget, supervisor
 * for durable runs).
 */

import { getSubagentDefaults } from "./defaults.js";
import { checkSubagentRuntime, detectStaleInstallInStderr } from "./health.js";

/**
 * Synthetic exit code used when `runReviewer` short-
 * circuits because the captured pi binary path is gone.
 * 127 is the POSIX convention for "command not found";
 * downstream code that inspects exit codes treats it
 * the same as any other non-zero failure.
 */
const STALE_RUNTIME_EXIT_CODE = 127;

import { ReviewerStreamParser } from "./stream.js";

function dedupePaths(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of paths) {
		if (seen.has(p)) continue;
		seen.add(p);
		out.push(p);
	}
	return out;
}

/** File-backed artifacts emitted by a supervised reviewer run. */
export interface ReviewerRunArtifacts {
	readonly runDir: string;
	readonly reviewerDir: string;
	readonly eventsPath: string;
	readonly stderrPath: string;
	readonly progressPath: string;
	readonly resultPath: string;
}

export { extractUsageFromPiStream } from "./stream.js";

/**
 * A subagent spec: identity, model, thinking level, tool
 * palette. This is the per-job input the engine reads; the
 * pr-workflow council layer uses the same shape to
 * describe one reviewer slot. The runner moves into
 * `lib/subagent/` in a later step, and the `CouncilReviewer`
 * alias below is retired then.
 */
export interface SubagentSpec {
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

/**
 * Legacy alias for {@link SubagentSpec}. Retained so the
 * pr-workflow internals don't churn during the engine
 * extraction; removed once the engine lifts into
 * `lib/subagent/` and pr-workflow imports `SubagentSpec`
 * directly.
 */
export type CouncilReviewer = SubagentSpec;

/** Thinking levels accepted by pi's `--thinking` flag. */
export type ReviewerThinkingLevel = "off" | "low" | "medium" | "high";

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
	/** Whether finalAssistantText was materialized from the verified payload. */
	readonly canonicalText?: boolean;
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
/**
 * Pre-dispatch health probe injected into `runReviewer`.
 *
 * Returns a structured error when the running pi binary
 * has disappeared from disk (typical cause: pi upgraded
 * mid-session and the old nix store entry was garbage-
 * collected). Returns `null` when dispatch is safe.
 */
export type SubagentRuntimeCheck = () => {
	readonly path: string;
	readonly message: string;
} | null;

export interface RunReviewerOptions {
	readonly reviewer: CouncilReviewer;
	/** Prompt text passed as the final positional arg. */
	readonly prompt: string;
	/** Working directory for the subprocess (worktree path). */
	readonly cwd: string;
	/**
	 * Optional system prompt forwarded to pi via
	 * `--system-prompt`. Callers use this to set the
	 * subagent's persona, baseline instructions or
	 * voice before the user prompt arrives. When omitted,
	 * pi falls back to its session default.
	 */
	readonly systemPrompt?: string;
	/**
	 * When true, ask pi to ignore every form of ambient
	 * inheritance (`--no-skills --no-context-files
	 * --no-extensions`). The subagent then sees only the
	 * `extraExtensions`, `extraSkills` and prompts the
	 * caller passes in. Used for clean-slate fleet runs
	 * where the user's local pi setup must not bleed in.
	 */
	readonly isolated?: boolean;
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
	 * Absolute paths of skill files to inject into the
	 * subagent via `--skill`. Used to teach the subagent
	 * its output contract without baking the prose into
	 * the prompt body. Loads in addition to whatever the
	 * user's pi setup auto-discovers.
	 */
	readonly extraSkills?: readonly string[];
	/**
	 * Whether the engine should enforce that the subagent
	 * called `verify_output` and got `ok: true` before
	 * accepting the run. Set this when injecting a verify
	 * extension via `extraExtensions`; otherwise the
	 * subagent's output is taken as-is. Defaults to
	 * `false`.
	 */
	readonly requiresVerification?: boolean;
	/**
	 * Optional stage label the subagent must echo back
	 * through `verify_output`. When set, a stage mismatch
	 * is treated as verification failure even if the tool
	 * returned `ok: true`. Opaque to the engine; callers
	 * choose their own stage vocabulary.
	 */
	readonly expectedVerificationStage?: string;
	/**
	 * Live event hook forwarded to the subprocess
	 * runner. The council orchestrator uses this to
	 * translate the reviewer's per-line stream into
	 * progress updates ("reading task.go", "running
	 * bash…") so the user sees signal mid-flight instead
	 * of dead air.
	 */
	readonly onEvent?: (event: RunPiStreamEvent) => void;
	/**
	 * Runtime health probe. Defaults to the module-level
	 * `checkSubagentRuntime` bound to `process.execPath`.
	 * Tests inject a fake to exercise the stale-runtime
	 * short-circuit without touching the real binary.
	 */
	readonly checkRuntime?: SubagentRuntimeCheck;
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
	// Refuse to spawn when pi was updated or removed
	// mid-session — the parent's argv-derived extension
	// paths point at a directory that no longer exists and
	// every subagent will crash with the same ENOENT.
	// Short-circuit with a clear advisory so the
	// dispatcher can suppress the misleading retry hint.
	const runtimeCheck = options.checkRuntime ?? checkSubagentRuntime;
	const runtimeError = runtimeCheck();
	if (runtimeError !== null) {
		return {
			reviewerId: options.reviewer.id,
			exitCode: STALE_RUNTIME_EXIT_CODE,
			finalAssistantText: "",
			stderr: runtimeError.message,
			warnings: [runtimeError.message],
		};
	}

	// Engine-wide defaults registered by other extensions
	// (credentials helpers, telemetry hooks, anything that
	// should be present in every subagent regardless of
	// isolation) are prepended here so they survive an
	// `isolated: true` flag without each call site having
	// to remember to thread them through. Per-call inputs
	// keep their own entries when the same path was also
	// registered as a default.
	const defaults = getSubagentDefaults();
	const extraExtensions = dedupePaths([
		...defaults.extensions,
		...(options.extraExtensions ?? []),
	]);
	const extraSkills = dedupePaths([
		...defaults.skills,
		...(options.extraSkills ?? []),
	]);
	const args = composeArgs({
		spec: options.reviewer,
		prompt: options.prompt,
		systemPrompt: options.systemPrompt,
		isolated: options.isolated,
		...(extraExtensions.length > 0 ? { extraExtensions } : {}),
		...(extraSkills.length > 0 ? { extraSkills } : {}),
	});
	const result = await options.runPi({
		args,
		cwd: options.cwd,
		...(options.runId ? { runId: options.runId } : {}),
		reviewerId: options.reviewer.id,
		signal: options.signal,
		onEvent: options.onEvent,
	});

	const parsed = extractRunPiOutput(result);
	const requiresVerification = options.requiresVerification === true;
	const verification =
		parsed.verification ??
		(requiresVerification
			? { called: false, ok: false, message: "verify_output was not called." }
			: undefined);
	const verificationMismatch = verificationStageMismatch(
		verification,
		options.expectedVerificationStage,
	);
	const verificationForResult = verificationMismatch
		? {
				...verificationMismatch.verification,
				ok: false,
				message: verificationMismatch.message,
			}
		: verification;
	const verified = verificationForResult?.ok
		? verifiedOutputText(verificationForResult.output)
		: null;
	const verifiedText = verified?.text ?? null;
	const hasRunnerCanonicalText =
		result.finalAssistantText !== undefined &&
		verificationForResult?.ok === true &&
		verificationForResult.canonicalText === true &&
		verificationForResult.output === undefined &&
		parsed.finalAssistantText.trim() !== "";
	const warnings = [...parsed.warnings];
	if (verified?.warning) warnings.push(verified.warning);
	if (verificationForResult?.warnings) {
		warnings.push(
			...verificationForResult.warnings.map(
				(warning) => `Reviewer verify_output warning: ${warning}`,
			),
		);
	}
	if (
		requiresVerification &&
		verifiedText === null &&
		!hasRunnerCanonicalText
	) {
		warnings.push(verificationFailureWarning(verificationForResult));
	}

	if (result.exitCode !== 0) {
		warnings.push(`Pi subprocess exited non-zero (exit ${result.exitCode})`);
		const stderrSnippet = summarizeStderr(parsed.stderr);
		if (stderrSnippet) {
			warnings.push(`Pi stderr: ${stderrSnippet}`);
		}
		// Defensive second layer: if the child's stderr
		// carries the canonical stale-install ENOENT shape,
		// add the actionable advisory so downstream summary
		// renderers can swap the per-reviewer retry hint for
		// a session-level "restart pi" message.
		const staleMessage = detectStaleInstallInStderr(parsed.stderr);
		if (staleMessage) warnings.push(staleMessage);
	}

	return {
		reviewerId: options.reviewer.id,
		exitCode: result.exitCode,
		finalAssistantText:
			requiresVerification && verifiedText === null && !hasRunnerCanonicalText
				? ""
				: (verifiedText ?? parsed.finalAssistantText),
		stderr: parsed.stderr,
		warnings,
		...(parsed.usage ? { usage: parsed.usage } : {}),
		...(verificationForResult
			? { verification: verificationWithoutOutput(verificationForResult) }
			: {}),
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
		...((result.verification ?? parsed.verification)
			? { verification: result.verification ?? parsed.verification }
			: {}),
	};
}

function verificationStageMismatch(
	verification: ReviewerVerification | undefined,
	expected: string | undefined,
): { verification: ReviewerVerification; message: string } | null {
	if (verification?.ok !== true || expected === undefined) return null;
	if (verification.stage === expected) return null;
	const actual = verification.stage ?? "missing";
	return {
		verification,
		message:
			"Reviewer output ignored because verify_output used the wrong stage " +
			`(${actual}); expected ${expected}.`,
	};
}

const MAX_VERIFIED_OUTPUT_BYTES = 512 * 1024;

function verifiedOutputText(
	output: unknown,
): { readonly text: string | null; readonly warning?: string } | null {
	if (output === undefined) return null;
	return truncateBytes(
		JSON.stringify(output, null, 2),
		MAX_VERIFIED_OUTPUT_BYTES,
	);
}

function verificationWithoutOutput(
	verification: ReviewerVerification,
): ReviewerVerification {
	const { output: _output, ...rest } = verification;
	return rest;
}

function truncateBytes(
	text: string,
	maxBytes: number,
): { readonly text: string | null; readonly warning?: string } {
	if (Buffer.byteLength(text) <= maxBytes) return { text };
	return {
		text: null,
		warning: `Reviewer verified output exceeded ${maxBytes} bytes; ignored`,
	};
}

function verificationFailureWarning(
	verification: ReviewerVerification | undefined,
): string {
	if (verification === undefined || !verification.called) {
		return "Reviewer output ignored because verify_output was not called.";
	}
	if (verification.ok && verification.output === undefined) {
		return "Reviewer output ignored because verify_output returned ok: true but the verified payload was not captured.";
	}
	if (verification.message?.startsWith("Reviewer output ignored")) {
		return verification.message;
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

interface ComposeArgsInput {
	readonly spec: SubagentSpec;
	readonly prompt: string;
	readonly systemPrompt?: string;
	readonly isolated?: boolean;
	readonly extraExtensions?: readonly string[];
	readonly extraSkills?: readonly string[];
}

function composeArgs(input: ComposeArgsInput): string[] {
	const args: string[] = ["--mode", "json", "--no-session", "-p"];
	if (input.spec.model) {
		args.push("--model", input.spec.model);
	}
	if (input.spec.thinkingLevel) {
		args.push("--thinking", input.spec.thinkingLevel);
	}
	if (input.spec.tools && input.spec.tools.length > 0) {
		args.push("--tools", buildToolsAllowlist(input.spec.tools));
	}
	if (input.systemPrompt) {
		args.push("--system-prompt", input.systemPrompt);
	}
	if (input.isolated) {
		// Pi's three flags together strip every form of
		// ambient inheritance: package- and user-scoped
		// skills, AGENTS.md context files and auto-
		// discovered extensions. Callers that pass
		// extraExtensions or extraSkills get those layered
		// back on top by the flags below; nothing else
		// loads.
		args.push("--no-skills", "--no-context-files", "--no-extensions");
	}
	if (input.extraExtensions) {
		for (const path of input.extraExtensions) {
			args.push("--extension", path);
		}
	}
	if (input.extraSkills) {
		for (const path of input.extraSkills) {
			args.push("--skill", path);
		}
	}
	args.push(input.prompt);
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

// ---------------------------------------------------------------------------
// New (engine-public) API surface
// ---------------------------------------------------------------------------
//
// The library publishes a small composite API on top of
// the flat `RunReviewerOptions`/`runReviewer` legacy used
// by pr-workflow. New consumers should prefer the
// `SubagentJob` + `runSubagent` shape; the legacy names
// remain so the existing pr-workflow callsites keep
// working unchanged. The two converge once pr-workflow
// migrates its callsites.

/**
 * A bundle of (extension, skill) paths that teach a
 * subagent its output contract and let it self-validate.
 * The extension registers the `verify_output` tool; the
 * companion skill (when present) carries the protocol
 * prose. Verify packs live next to their consumers; the
 * library treats them opaquely.
 */
export interface VerifyPack {
	/** Absolute path to the verify extension's entry file. */
	readonly extensionPath: string;
	/** Absolute path to the companion skill, when present. */
	readonly skillPath?: string;
}

/**
 * The work to do for one subagent run, without the
 * ambient infrastructure (runner, signal, event hook).
 * Callers compose a job, pair it with a {@link SubagentSpec}
 * and pass both to {@link runSubagent}.
 */
export interface SubagentJob {
	/** Optional `--system-prompt` text. */
	readonly systemPrompt?: string;
	/** User prompt passed as the final positional arg. */
	readonly userPrompt: string;
	/** Working directory for the subprocess. */
	readonly cwd: string;
	/**
	 * When true, strip ambient inheritance via
	 * `--no-skills --no-context-files --no-extensions`.
	 * Defaults to `false`; callers that want a clean slate
	 * opt in explicitly.
	 */
	readonly isolated?: boolean;
	/** Absolute paths to inject via `--extension`. */
	readonly extraExtensions?: readonly string[];
	/** Absolute paths to inject via `--skill`. */
	readonly extraSkills?: readonly string[];
	/**
	 * Verify pack. When set the engine injects the
	 * extension (and skill, when present) and enforces
	 * that `verify_output` was called and returned
	 * `ok: true` before accepting the run.
	 */
	readonly verify?: VerifyPack;
}

/** Token + cost figures for one subagent run. */
export type SubagentUsage = ReviewerUsage;

/** Verify-output outcome surfaced on a subagent run result. */
export type SubagentVerification = ReviewerVerification;

/** Result of one subagent's run. */
export interface SubagentRunResult {
	readonly subagentId: string;
	readonly exitCode: number;
	readonly finalAssistantText: string;
	readonly stderr: string;
	readonly warnings: readonly string[];
	readonly usage?: SubagentUsage;
	readonly verification?: SubagentVerification;
}

/**
 * Run one subagent. Thin wrapper over {@link runReviewer}
 * that takes the composite (spec, job, runtime) shape
 * exported by the library. New consumers should call this
 * function instead of `runReviewer`.
 */
export async function runSubagent(opts: {
	readonly spec: SubagentSpec;
	readonly job: SubagentJob;
	readonly runPi: RunPi;
	readonly runId?: string;
	readonly signal?: AbortSignal;
	readonly onEvent?: (event: RunPiStreamEvent) => void;
}): Promise<SubagentRunResult> {
	const { job, verify } = { job: opts.job, verify: opts.job.verify };
	const extraExtensions = [
		...(job.extraExtensions ?? []),
		...(verify ? [verify.extensionPath] : []),
	];
	const extraSkills = [
		...(job.extraSkills ?? []),
		...(verify?.skillPath ? [verify.skillPath] : []),
	];
	const result = await runReviewer({
		reviewer: opts.spec,
		prompt: job.userPrompt,
		cwd: job.cwd,
		...(job.systemPrompt ? { systemPrompt: job.systemPrompt } : {}),
		...(job.isolated ? { isolated: true } : {}),
		...(extraExtensions.length > 0 ? { extraExtensions } : {}),
		...(extraSkills.length > 0 ? { extraSkills } : {}),
		...(verify ? { requiresVerification: true } : {}),
		runPi: opts.runPi,
		...(opts.runId ? { runId: opts.runId } : {}),
		...(opts.signal ? { signal: opts.signal } : {}),
		...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
	});
	return {
		subagentId: result.reviewerId,
		exitCode: result.exitCode,
		finalAssistantText: result.finalAssistantText,
		stderr: result.stderr,
		warnings: result.warnings,
		...(result.usage ? { usage: result.usage } : {}),
		...(result.verification ? { verification: result.verification } : {}),
	};
}

/** Result of one fleet fan-out: per-subagent results and aggregate warnings. */
export interface FleetResult {
	readonly results: readonly SubagentRunResult[];
	readonly warnings: readonly string[];
}

/**
 * Fan one job per subagent out in parallel. Each
 * (spec, job) pair runs as its own pi process; failures
 * become warnings on their own result rather than aborting
 * the fleet. Callers that need progress observability
 * thread an `onEvent` per assignment through the
 * `assignments` array.
 *
 * Both non-zero exits (captured by `runSubagent` itself)
 * and pre-flight spawn errors (a rejected promise from
 * `runSubagent`) are contained: a rejected assignment
 * becomes a synthesized result carrying the error message
 * as a warning so successful siblings still surface.
 */
export async function runFleet(opts: {
	readonly assignments: ReadonlyArray<{
		readonly spec: SubagentSpec;
		readonly job: SubagentJob;
		readonly onEvent?: (event: RunPiStreamEvent) => void;
	}>;
	readonly runPi: RunPi;
	readonly runId?: string;
	readonly signal?: AbortSignal;
}): Promise<FleetResult> {
	const settled = await Promise.allSettled(
		opts.assignments.map((assignment) =>
			runSubagent({
				spec: assignment.spec,
				job: assignment.job,
				runPi: opts.runPi,
				...(opts.runId ? { runId: opts.runId } : {}),
				...(opts.signal ? { signal: opts.signal } : {}),
				...(assignment.onEvent ? { onEvent: assignment.onEvent } : {}),
			}),
		),
	);
	const results = settled.map((outcome, index) =>
		outcome.status === "fulfilled"
			? outcome.value
			: synthesizeRejectedResult(opts.assignments[index].spec, outcome.reason),
	);
	const warnings: string[] = [];
	for (const r of results) {
		for (const w of r.warnings) warnings.push(`${r.subagentId}: ${w}`);
	}
	return { results, warnings };
}

function synthesizeRejectedResult(
	spec: SubagentSpec,
	reason: unknown,
): SubagentRunResult {
	const message = reason instanceof Error ? reason.message : String(reason);
	return {
		subagentId: spec.id,
		exitCode: -1,
		finalAssistantText: "",
		stderr: "",
		warnings: [`subagent failed to start: ${message}`],
	};
}

/**
 * Canonical prose instructing a subagent how to use
 * `verify_output`: call it before ending, retry on
 * `ok: false`, end when `ok: true`. Returned as a single
 * paragraph so callers can drop it into a prompt body.
 * Pairs with whichever {@link VerifyPack} the caller
 * injects — the engine doesn't know which tool name is in
 * use beyond the convention that it's `verify_output`.
 */
export function verifyProtocolInstruction(): string {
	return [
		"Before ending your run, call the `verify_output` tool with your",
		"final structured output as `output`. If the tool returns `ok: false`,",
		"read the errors, fix your output and call `verify_output` again.",
		"End your run only when the most recent `verify_output` call returned",
		"`ok: true`. Do not skip this step \u2014 the parent rejects unverified runs.",
	].join(" ");
}
