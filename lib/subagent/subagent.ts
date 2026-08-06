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
 * orchestrators (the review ask rounds, the
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

import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only, and erased, so the pairing with artifacts.ts importing
// ReviewerRunArtifacts back out of here is not a runtime cycle. The
// state belongs beside the store that writes it and the result that
// reports it, and those are two files.
import {
	ReviewerArtifactsStore,
	type ReviewerTerminalState,
} from "./artifacts.js";
import { getSubagentDefaults } from "./defaults.js";
import { checkSubagentRuntime, detectStaleInstallInStderr } from "./health.js";
import {
	classifyReviewerError,
	describeReviewerError,
	type ReviewerError,
} from "./reviewer-error.js";
import type { StartedPi, StartPi } from "./runpi/supervisor.js";

export type { ReviewerError } from "./reviewer-error.js";

/**
 * Synthetic exit code used when `runReviewer` short-
 * circuits because the captured pi binary path is gone.
 * 127 is the POSIX convention for "command not found";
 * downstream code that inspects exit codes treats it
 * the same as any other non-zero failure.
 */
const STALE_RUNTIME_EXIT_CODE = 127;

/**
 * Lower bound on per-call timeout overrides. Mirrors the
 * tool schema's `Type.Integer({ minimum: 1000 })` so the
 * library boundary applies the same floor regardless of
 * which entry point fires (the fleet tool, a review round,
 * a direct library consumer).
 */
const MIN_TIMEOUT_MS = 1000;

/**
 * Upper bound on per-call timeout overrides. Eight hours
 * covers overnight benchmark soaks, long deep-investigation
 * personas and the slowest reviewer at xhigh thinking on a
 * stack of meaningful PRs. Stays well below Node's
 * 32-bit-signed-int timer ceiling (~24.8 days) where
 * `setTimeout` silently coerces back to 1 ms.
 */
const MAX_TIMEOUT_MS = 8 * 60 * 60 * 1000;

/**
 * Validate a per-call timeout override at the library
 * boundary. Throws when the value is not a finite
 * integer, sits below the floor or exceeds the ceiling.
 * Callers that pass `undefined` are leaving the runner
 * default in place and skip the check.
 */
function validateTimeout(field: string, value: number | undefined): void {
	if (value === undefined) return;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isInteger(value)
	) {
		throw new Error(
			`Invalid ${field}: expected a finite integer in milliseconds, got ${String(value)}.`,
		);
	}
	if (value < MIN_TIMEOUT_MS) {
		throw new Error(
			`Invalid ${field}: ${value} ms is below the ${MIN_TIMEOUT_MS} ms floor.`,
		);
	}
	if (value > MAX_TIMEOUT_MS) {
		throw new Error(
			`Invalid ${field}: ${value} ms exceeds the ${MAX_TIMEOUT_MS} ms ceiling.`,
		);
	}
}

/**
 * Validate the timeout pair as a whole. `idleTimeoutMs`
 * higher than `timeoutMs` would let the wall-clock cap
 * fire first regardless of how patient the idle ceiling
 * is, a footgun for someone who only bumps one column
 * of the sizing table. Caught here so library callers
 * see the same error the tool schema would have raised.
 */
function validateTimeoutPair(
	timeoutMs: number | undefined,
	idleTimeoutMs: number | undefined,
	// The third clock, validated with the other two rather than
	// beside them. It is the one that reaches the watchdog as JSON,
	// where a NaN serializes to null and every comparison against it
	// is false except the one that stops the child, so an unchecked
	// reserve does not misbehave subtly: it kills the whole roster on
	// the first tick.
	wrapUpReserveMs?: number,
): void {
	validateTimeout("timeoutMs", timeoutMs);
	validateTimeout("idleTimeoutMs", idleTimeoutMs);
	if (wrapUpReserveMs !== 0) {
		// Zero is the documented way to switch the soft deadline off,
		// so it is the one value below the floor that means something.
		validateTimeout("wrapUpReserveMs", wrapUpReserveMs);
	}
	if (
		timeoutMs !== undefined &&
		idleTimeoutMs !== undefined &&
		idleTimeoutMs > timeoutMs
	) {
		throw new Error(
			`Invalid timeout pair: idleTimeoutMs (${idleTimeoutMs} ms) exceeds timeoutMs (${timeoutMs} ms); the wall clock would fire first.`,
		);
	}
}

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
	/**
	 * File the reviewer's verify_output tool writes its
	 * validated payload to. The supervisor reads it back
	 * out-of-band so a large review never rides the
	 * size-capped event stream.
	 */
	readonly verifiedOutputPath: string;
	/**
	 * File the reviewer appends a finding to the moment it
	 * forms one, rather than saving them all for its answer.
	 *
	 * One JSON object per line, so a reviewer stopped partway
	 * through writing costs the line it was on and nothing
	 * before it. Everything else about a stop is recovery,
	 * which only works if the answer arrives; this does not
	 * need the reviewer to live long enough to say it twice.
	 *
	 * Absent from a runner that keeps no artifacts, which has
	 * nowhere to put one.
	 */
	readonly journalPath?: string;
	/**
	 * Private per-reviewer directory pi persists the session
	 * into (via --session-dir). Kept out of the user's session
	 * list so a supervised run leaves no trace there.
	 */
	readonly sessionDir?: string;
	/**
	 * The session file pi minted inside sessionDir, discovered
	 * after the run. Absent when the reviewer crashed before
	 * writing a session. This is what a resume reopens.
	 */
	readonly sessionPath?: string;
}

export { extractUsageFromPiStream } from "./stream.js";

/**
 * A subagent spec: identity, model, thinking level, tool
 * palette. This is the per-job input the engine reads, and
 * a review round uses the same shape to describe one
 * participant. The `CouncilReviewer` alias below is
 * retired once its remaining callers use this name.
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
 * Legacy alias for {@link SubagentSpec}, from when the only
 * caller was a council of reviewers. Kept because callers
 * still name it; removed once they say `SubagentSpec`.
 */
export type CouncilReviewer = SubagentSpec;

/** Thinking levels accepted by pi's `--thinking` flag. */
export type ReviewerThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

export interface ReviewerVerification {
	/** Whether the reviewer called verify_output at least once. */
	readonly called: boolean;
	/** Whether the last verify_output call returned ok: true. */
	readonly ok: boolean;
	/**
	 * How many times verify_output ran before the recorded
	 * result. One means the first attempt was the last; higher
	 * means the reviewer retried to reach a valid payload.
	 */
	readonly attempts?: number;
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
	/**
	 * Whether the output arrived out-of-band, from the
	 * verify-output file rather than the event stream. When
	 * set, the payload bypassed every stream and text size
	 * cap, so the parent must not re-apply them.
	 */
	readonly outOfBand?: boolean;
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
	/**
	 * Findings the reviewer wrote down as it worked, read back
	 * off its journal. Unparsed: whoever asked knows what a
	 * finding is, and this does not.
	 */
	readonly journal?: readonly unknown[];
	/**
	 * What went wrong reading the journal back, when something
	 * did. Its own field because these say findings were left
	 * behind, and a caller that replaces the general warnings
	 * with a sentence of its own drops exactly those.
	 */
	readonly journalWarnings?: readonly string[];
	/**
	 * The terminal turn's error, when the run ended on a
	 * provider or transport failure rather than a clean stop.
	 */
	readonly error?: ReviewerError;
	/** Durable files backing this run, when available. */
	readonly artifacts?: ReviewerRunArtifacts;
	/**
	 * How the run ended, as the supervisor classified it.
	 *
	 * An exit code cannot say this. A reviewer stopped at a wall clock
	 * and one that answered badly can both arrive with text and a
	 * non-zero code, and a caller that cannot tell them apart blames
	 * the reviewer for a deadline we set. Absent from unsupervised
	 * runners, which never knew.
	 */
	readonly state?: ReviewerTerminalState;
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
	/**
	 * How much of the wall clock to keep back for an answer.
	 *
	 * A reserve rather than a deadline, because only the runner
	 * knows what the wall clock actually is: the caller may not
	 * have set one, and the configured default lives here. Given
	 * one, the supervisor stops the run that much before its
	 * deadline so the rest can be spent asking for what it has.
	 */
	readonly wrapUpReserveMs?: number;
	/**
	 * Whether this run should persist its pi session so a
	 * later resume can reopen it. Defaults to false: a run is
	 * ephemeral unless the caller asks to keep the transcript.
	 * The reviewer path sets it true (paired with autoResume);
	 * fleet jobs leave it false and stay ephemeral.
	 */
	readonly persistSession?: boolean;
	/**
	 * Per-call hard wall-clock timeout in milliseconds.
	 * Overrides the runner's configured default. Use for
	 * one-off long-running subagents (soak tests, recovery
	 * runs) without bumping the global default.
	 */
	readonly timeoutMs?: number;
	/**
	 * Per-call idle timeout in milliseconds: how long the
	 * supervisor will wait between supervisor protocol
	 * events before declaring the child stuck. Overrides
	 * the runner's configured default. Set high when the
	 * subagent issues long-running bash commands that don't
	 * stream progress (deploys, benchmarks). Non-supervising
	 * runners (e.g. the raw spawn runner) ignore the value
	 * and surface a one-line warning on the result so the
	 * caller knows the override didn't apply.
	 */
	readonly idleTimeoutMs?: number;
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
	 * bash...") so the user sees signal mid-flight instead
	 * of dead air.
	 */
	readonly onEvent?: (event: RunPiStreamEvent) => void;
	/**
	 * Per-call hard wall-clock timeout in milliseconds.
	 * Forwarded to `runPi`. Overrides the runner's
	 * configured default for this one call.
	 */
	readonly timeoutMs?: number;
	/**
	 * How much of that wall clock to keep back so this reviewer
	 * can be asked for its answer before the deadline takes it.
	 *
	 * Defaults to the wrap-up's own budget, which is the number
	 * that makes the two agree: the time reserved is the time the
	 * wrap-up is allowed. Ignored when `autoResume` is false,
	 * since a run that cannot be resumed cannot be asked.
	 */
	readonly wrapUpReserveMs?: number;
	/**
	 * Per-call idle timeout in milliseconds. Forwarded to
	 * `runPi`. Overrides the runner's configured default
	 * for this one call. Use when the subagent will issue
	 * long-running bash commands that stay silent on
	 * stdout.
	 */
	readonly idleTimeoutMs?: number;
	/**
	 * Runtime health probe. Defaults to the module-level
	 * `checkSubagentRuntime` bound to `process.execPath`.
	 * Tests inject a fake to exercise the stale-runtime
	 * short-circuit without touching the real binary.
	 */
	readonly checkRuntime?: SubagentRuntimeCheck;
	/**
	 * Whether to automatically resume once when the run ends
	 * on a transient error and a session was persisted.
	 * Defaults to true. The resume reopens the reviewer's own
	 * session, so its investigation is not re-run; only the
	 * final synthesis reruns, riding the prompt cache. Resume
	 * is a no-op unless a session was persisted, so a caller
	 * that does not persist one (the fleet path) never resumes
	 * regardless; set false to opt out explicitly, which
	 * deterministic tests do.
	 */
	readonly autoResume?: boolean;
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
	/**
	 * What the run had said before it was stopped, when it was later
	 * asked for its findings and answered.
	 *
	 * Kept apart rather than joined onto the answer. Joined, it reads as
	 * one answer to anything that parses this, and two objects are not
	 * one: the reader falls through to salvaging a truncated answer,
	 * reports a complete wrap-up as cut off, and can prefer the fragment
	 * over it. Which of the two holds the better answer is a question
	 * only something able to read findings can settle, and nothing here
	 * can.
	 */
	readonly priorAssistantText?: string;
	/** Whether a stopped run was asked for its findings and gave them. */
	readonly wrappedUp?: boolean;
	/**
	 * Findings the reviewer wrote down while it worked, rather
	 * than saving them for its answer. On the wire, because a
	 * finding belongs to a round and this does not know one.
	 */
	readonly journal?: readonly unknown[];
	/** What went wrong reading that journal back, if anything. */
	readonly journalWarnings?: readonly string[];
	readonly stderr: string;
	readonly warnings: string[];
	/**
	 * Token + cost totals summed across every assistant
	 * message_end event in the run. `undefined` when the
	 * stream carried no usage block (older pi, fake runners).
	 */
	readonly usage?: ReviewerUsage;
	/** Result of the reviewer's verify_output calls, when observed. */
	readonly verification?: ReviewerVerification;
	/**
	 * The terminal turn's error, when the run ended on a
	 * provider or transport failure rather than a clean stop.
	 * Carried through so the dispatcher can tell a dropped
	 * reviewer from one that merely never verified, and decide
	 * whether the failure is worth resuming.
	 */
	readonly error?: ReviewerError;
	/**
	 * How the run ended, when a supervised runner classified it.
	 *
	 * The one thing that separates a reviewer we stopped from one
	 * that answered badly, and neither the exit code nor the text
	 * can carry it.
	 */
	readonly state?: ReviewerTerminalState;
}

/** What starting a reviewer needs, which is less than running one. */
export type StartReviewerOptions = Omit<
	RunReviewerOptions,
	"runPi" | "signal" | "onEvent" | "autoResume"
> & {
	/** Dispatch it and return; nothing will wait for it. */
	readonly startPi: StartPi;
	/** Root of the reviewer artifact tree, where the prompt is kept. */
	readonly stateDir: string;
};

/**
 * Start one reviewer and walk away from it.
 *
 * The same composition `runReviewer` does, minus everything that only
 * means something to a caller who is waiting: no resume after a
 * transient drop, no wrap-up for a reviewer we stopped, no progress
 * events, no cancellation. Those are not omissions to be filled in
 * later. A detached reviewer has no parent to notice it dropped, so
 * what protects it is the supervisor's own watchdogs and the journal
 * it writes as it goes.
 */
export async function startReviewer(
	options: StartReviewerOptions,
): Promise<StartedPi> {
	// The same validation the waiting path does, and a detached round
	// is the worst place to find out a budget is nonsense: nobody is
	// watching it spend.
	validateTimeoutPair(
		options.timeoutMs,
		options.idleTimeoutMs,
		options.wrapUpReserveMs,
	);

	const runtimeError = (options.checkRuntime ?? checkSubagentRuntime)();
	if (runtimeError !== null) throw runtimeError;

	const defaults = getSubagentDefaults();
	const extraExtensions = dedupePaths([
		...defaults.extensions,
		...(options.extraExtensions ?? []),
	]);
	const extraSkills = dedupePaths([
		...defaults.skills,
		...(options.extraSkills ?? []),
	]);

	// Written into the reviewer's own directory, not a temp file. The
	// waiting path removes its prompt in a finally, which is right
	// there and fatal here: the parent returns before the child has
	// read it. It also makes the question part of the durable record,
	// which for a round that outlives its session is the only place
	// the question survives at all.
	const store = new ReviewerArtifactsStore(options.stateDir);
	const runId = options.runId ?? `reviewer-${Date.now()}`;
	const paths = await store.ensureReviewerDir(runId, options.reviewer.id);
	await writeFile(paths.promptPath, options.prompt, "utf8");

	return options.startPi({
		args: composeArgs({
			spec: options.reviewer,
			prompt: `@${paths.promptPath}`,
			systemPrompt: options.systemPrompt,
			isolated: options.isolated,
			...(extraExtensions.length > 0 ? { extraExtensions } : {}),
			...(extraSkills.length > 0 ? { extraSkills } : {}),
		}),
		cwd: options.cwd,
		runId,
		reviewerId: options.reviewer.id,
		// Always. A detached reviewer cannot be resumed by the parent
		// that started it, so the session on disk is the only thing that
		// makes a later resume or wrap-up possible at all.
		persistSession: true,
		...(options.timeoutMs !== undefined
			? { timeoutMs: options.timeoutMs }
			: {}),
		...(options.idleTimeoutMs !== undefined
			? { idleTimeoutMs: options.idleTimeoutMs }
			: {}),
		// No reserve, deliberately, and by omission rather than by zero.
		// The soft deadline buys time for a wrap-up, and a wrap-up is
		// dispatched by the parent that was waiting. Nobody is, so
		// reserving would stop the reviewer early and ask it nothing:
		// strictly less review for the same money. What protects a
		// detached reviewer instead is the journal it writes as it goes,
		// which is why that had to exist first.
	});
}

/**
 * Spawn one reviewer subagent, capture its output, and
 * extract the final assistant turn's text for downstream
 * finding parsing.
 */
export async function runReviewer(
	options: RunReviewerOptions,
): Promise<RunReviewerResult> {
	// Per-call timeout overrides arrive as opaque numbers
	// from the public API (library consumers and the fleet
	// tool). The schema enforces a floor at the tool
	// boundary, but the library is also a public entry
	// point: a review round's participants and any future
	// caller land here. Validate once at the boundary so
	// nonsense values (NaN, negatives, idle > wall) never
	// reach the runner where they'd kill the child or
	// silently bypass the ceiling.
	validateTimeoutPair(
		options.timeoutMs,
		options.idleTimeoutMs,
		options.wrapUpReserveMs,
	);

	// Refuse to spawn when pi was updated or removed
	// mid-session, since the parent's argv-derived extension
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
	// The prompt carries the whole review payload: the
	// persona standard plus every inlined PR diff. On a
	// stack review that runs past macOS ARG_MAX
	// (1,048,576 bytes), and a prompt passed on argv crashes
	// the pi child at spawn. Write it to a temp file and
	// hand pi an `@<path>` reference instead, which pi merges
	// into the prompt, so argv stays tiny whatever the diff
	// size. The file is removed once the run resolves, which is safe
	// only because this path waits for it: `startReviewer` writes into
	// the reviewer's own directory and removes nothing, since its
	// child may not have read the prompt by the time it returns.
	const reserve = wrapUpReserve(options);
	const promptFile = await writeReviewerPrompt(options.prompt);
	const args = composeArgs({
		spec: options.reviewer,
		prompt: `@${promptFile}`,
		systemPrompt: options.systemPrompt,
		isolated: options.isolated,
		...(extraExtensions.length > 0 ? { extraExtensions } : {}),
		...(extraSkills.length > 0 ? { extraSkills } : {}),
	});
	let result: RunPiResult;
	try {
		result = await options.runPi({
			args,
			cwd: options.cwd,
			...(options.runId ? { runId: options.runId } : {}),
			reviewerId: options.reviewer.id,
			signal: options.signal,
			onEvent: options.onEvent,
			// Persist the session only when a resume could use it.
			// The fleet path opts out of autoResume, so its jobs
			// stay ephemeral rather than leaving transcripts behind.
			persistSession: options.autoResume !== false,
			...(options.timeoutMs !== undefined
				? { timeoutMs: options.timeoutMs }
				: {}),
			...(options.idleTimeoutMs !== undefined
				? { idleTimeoutMs: options.idleTimeoutMs }
				: {}),
			...(reserve === undefined ? {} : { wrapUpReserveMs: reserve }),
		});
	} finally {
		// Best-effort: the OS temp dir is reaped anyway, and a
		// failed unlink must not mask the run's own outcome.
		await rm(promptFile, { force: true }).catch(() => {});
	}

	let outcome = assembleReviewerResult(options, result);
	// A transient drop leaves the investigation intact in the
	// persisted session, so resume once from there rather than
	// re-running from scratch. Fatal errors and runs with no
	// session are left to surface untouched.
	if (
		options.autoResume !== false &&
		outcome.error !== undefined &&
		// A verified first attempt is authoritative; never let a
		// resume replace a good result with a failed retry.
		outcome.verification?.ok !== true &&
		// A cancelled run must not resume: the user asked to stop.
		options.signal?.aborted !== true &&
		result.artifacts?.sessionPath !== undefined &&
		classifyReviewerError(outcome.error) === "transient"
	) {
		const resumeResult = await dispatchResume(
			options,
			result.artifacts.sessionPath,
			extraExtensions,
			extraSkills,
		);
		outcome = mergeResumeOutcome(
			outcome,
			assembleReviewerResult(options, resumeResult),
		);
	}

	// A reviewer we stopped is not a reviewer that failed. It was
	// working, it has its investigation in a session on disk, and the
	// only thing missing is the answer. Asking for that answer costs one
	// short turn against work already paid for, where the alternative is
	// a round that reports an interruption and nothing else.
	//
	// At most once, and at most once more after a resume, so one
	// participant costs three runs at the very worst: the attempt, a
	// resume after a transient drop, and this. The third is the cheap
	// one, capped at five minutes and at whatever the caller allowed.
	if (
		options.autoResume !== false &&
		options.signal?.aborted !== true &&
		outcome.state !== undefined &&
		WORTH_ASKING.has(outcome.state) &&
		outcome.verification?.ok !== true &&
		result.artifacts?.sessionPath !== undefined
	) {
		try {
			const wrapUp = await dispatchWrapUp(
				options,
				result.artifacts.sessionPath,
				extraExtensions,
				extraSkills,
			);
			outcome = mergeWrapUpOutcome(
				outcome,
				assembleReviewerResult(options, wrapUp),
			);
		} catch (error) {
			// The runner rejects rather than returning on a spawn failure,
			// and letting that out would turn a stopped run whose fragment
			// we had into a bare failure with nothing kept: the opposite of
			// the point. Asking is an extra, so failing to ask costs a
			// warning and nothing else.
			outcome = {
				...outcome,
				warnings: [
					...outcome.warnings,
					`Could not ask this stopped reviewer for its findings: ${
						error instanceof Error ? error.message : String(error)
					}. What it had already written is kept.`,
				],
			};
		}
	}
	return outcome;
}

/**
 * Stops worth asking about.
 *
 * A clock or an output cap took a working reviewer away, so what it
 * had is still worth having. Cancelled is not here because somebody
 * asked for the work to stop, and parent-exit is not because there is
 * nothing left to ask with.
 */
const WORTH_ASKING: ReadonlySet<ReviewerTerminalState> =
	new Set<ReviewerTerminalState>([
		"timeout",
		"idle-timeout",
		"output-limit",
		// The state that exists to be asked. A soft deadline stops a
		// healthy run for no other purpose, so leaving it out here would
		// take the reviewer's remaining time and give nothing back.
		"soft-deadline",
	]);

/**
 * What to say to a reviewer that ran out of time.
 *
 * Every line of this is aimed at one failure: a reviewer that treats
 * being resumed as permission to carry on working, meets the same wall
 * and costs the round a second time for nothing. It is asked for what
 * it has already formed, in the shape the contract asks for, and told
 * that a short answer is the right answer.
 */
const WRAP_UP_PROMPT =
	"You ran out of time and were stopped. Do not investigate further, do " +
	"not read any more files and do not continue the work: there is no " +
	"budget left for it, and anything you start now will be cut off again. " +
	"Reply now, in the JSON shape your instructions asked for, with only the " +
	"findings you had already formed. Leave out anything you were still " +
	"checking. A short answer of what you are sure of is exactly what is " +
	"wanted here, and is worth far more than nothing, which is what the " +
	"round gets otherwise.";

/**
 * How long a wrap-up gets.
 *
 * Small on purpose. This is a reviewer writing down what it already
 * knows, so it needs a fraction of a review, and a generous budget here
 * would hand a reviewer that ignored the prompt enough room to start
 * the whole investigation again.
 */
export const WRAP_UP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How much of a reviewer's wall clock is kept back for its answer.
 *
 * The difference between asking and taking. Without a reserve a
 * reviewer investigates until the wall clock kills it, and the wrap-up
 * then runs on time nobody budgeted, after a stop that has already
 * been recorded as one. With it, the reviewer is stopped early and
 * deliberately, and the time it did not spend investigating is the
 * time it has to answer in.
 *
 * The round costs the same either way. What changes is that the
 * reviewer is asked while there is still something to ask with.
 */
function wrapUpReserve(
	options: Pick<RunReviewerOptions, "autoResume" | "wrapUpReserveMs">,
): number | undefined {
	// A run nobody can resume cannot be wrapped up, so stopping it
	// early would take time away and give nothing back. That is the
	// fleet path, which opts out of autoResume and stays ephemeral.
	if (options.autoResume === false) return undefined;
	// Zero switches it off, which is what the documentation promises
	// and what somebody who wants the old behaviour will reach for.
	// Left to `??` it would have read as absent and handed back the
	// default, so the off switch would have turned it on.
	if (options.wrapUpReserveMs === 0) return undefined;
	return options.wrapUpReserveMs ?? WRAP_UP_TIMEOUT_MS;
}

/**
 * How long the wrap-up itself may run.
 *
 * The same function that decides what to keep back, called again
 * where it is spent, because these are one number and were briefly
 * two. Taking the reserve uncapped and spending it clamped at five
 * minutes meant a configured `answerMs` of ten minutes took ten
 * minutes of investigation away and handed five of them back. The
 * defaults hid it exactly: both constants were five minutes, written
 * in two modules with nothing joining them.
 *
 * Still never longer than the caller's whole budget, which only binds
 * when no soft deadline fired, since one that did already proved the
 * reserve was the smaller number.
 */
function wrapUpBudget(options: RunReviewerOptions): number {
	const reserve = wrapUpReserve(options) ?? WRAP_UP_TIMEOUT_MS;
	return Math.min(reserve, options.timeoutMs ?? reserve);
}

/**
 * A suffix, so a wrap-up does not overwrite the record of the stop.
 *
 * The artifacts directory is derived from the run and reviewer ids
 * alone, and the result file is written by rename, so reusing both ids
 * replaces the stopped run's own record with one saying the reviewer
 * completed. That record is the evidence this whole line of work
 * exists to keep, and recovery reads it.
 */
const WRAP_UP_SUFFIX = "+wrapup";

/** The same, for a resume, and for the same reason. */
const RESUME_SUFFIX = "+resume";

/** Ask a stopped reviewer to hand over what it already has. */
async function dispatchWrapUp(
	options: RunReviewerOptions,
	sessionPath: string,
	extraExtensions: readonly string[],
	extraSkills: readonly string[],
): Promise<RunPiResult> {
	const args = composeArgs({
		spec: options.reviewer,
		prompt: WRAP_UP_PROMPT,
		systemPrompt: options.systemPrompt,
		isolated: options.isolated,
		resumeSessionPath: sessionPath,
		...(extraExtensions.length > 0 ? { extraExtensions } : {}),
		...(extraSkills.length > 0 ? { extraSkills } : {}),
	});
	// Never longer than the caller allowed, and never shorter on the
	// idle clock than the wall it runs under. Shortening an idle clock
	// on its own is how six rounds of working reviewers were killed:
	// silence is not idleness, and a reviewer composing a long answer
	// goes quiet while it does.
	const wall = wrapUpBudget(options);
	const idle = Math.min(options.idleTimeoutMs ?? wall, wall);
	return options.runPi({
		args,
		cwd: options.cwd,
		...(options.runId ? { runId: options.runId } : {}),
		reviewerId: `${options.reviewer.id}${WRAP_UP_SUFFIX}`,
		timeoutMs: wall,
		idleTimeoutMs: idle,
		signal: options.signal,
		onEvent: options.onEvent,
	});
}

/**
 * Fold a wrap-up into the run it belongs to.
 *
 * The stop stands. The reviewer handed over what it had; it did not
 * finish the review, and reporting the pass as complete would put a
 * fresh lie exactly where the old one was. What changes is that the
 * round now has the answer as well as the interruption.
 *
 * Both texts survive, apart rather than joined. A wrap-up can come
 * back empty or cut off in its turn, and the fragment is then the only
 * answer there is; joining them defeats every branch of the reader
 * that has to parse the result.
 */
export function mergeWrapUpOutcome(
	stopped: RunReviewerResult,
	wrapUp: RunReviewerResult,
): RunReviewerResult {
	const answered = wrapUp.finalAssistantText.trim() !== "";
	const had = stopped.finalAssistantText.trim() !== "";
	const usage = sumReviewerUsage(stopped.usage, wrapUp.usage);
	const note =
		wrapUp.finalAssistantText.trim() === ""
			? "Asked this reviewer for the findings it had when it was stopped; it answered with nothing, so this is what it had written at the time."
			: "This reviewer was stopped before it finished and was asked for the findings it had already formed. What follows is that answer, not a completed review.";
	return {
		...stopped,
		finalAssistantText: answered
			? wrapUp.finalAssistantText
			: stopped.finalAssistantText,
		...(answered && had
			? { priorAssistantText: stopped.finalAssistantText }
			: {}),
		...(answered ? { wrappedUp: true } : {}),
		// Both runs' journals. The wrap-up runs in the same reviewer
		// directory's sibling, so these are two files, and a finding
		// recorded before the stop is not superseded by one recorded
		// after it. The round dedupes.
		...(stopped.journal || wrapUp.journal
			? { journal: [...(stopped.journal ?? []), ...(wrapUp.journal ?? [])] }
			: {}),
		warnings: [...stopped.warnings, note, ...wrapUp.warnings],
		...(usage ? { usage } : {}),
	};
}

/**
 * The continuation prompt for a resumed reviewer. The prior
 * investigation is already in the session, so the resume
 * must not repeat it; it only has to finish and verify.
 */
const RESUME_CONTINUATION_PROMPT =
	"Your previous turn was interrupted before you finished, likely by a " +
	"dropped model stream. Do not restart your investigation or repeat any " +
	"tool calls; your prior work is already in this session. Review what you " +
	"have and call verify_output with your complete result now.";

/**
 * Resume a dropped reviewer from its persisted session. Same
 * model, tools, extensions and system prompt as the initial
 * run, continuing the same session, which the session path
 * carries rather than the ids.
 *
 * Under its own reviewer id, so it keeps its own artifacts
 * rather than writing over the attempt it is recovering.
 */
async function dispatchResume(
	options: RunReviewerOptions,
	sessionPath: string,
	extraExtensions: readonly string[],
	extraSkills: readonly string[],
): Promise<RunPiResult> {
	const args = composeArgs({
		spec: options.reviewer,
		prompt: RESUME_CONTINUATION_PROMPT,
		systemPrompt: options.systemPrompt,
		isolated: options.isolated,
		resumeSessionPath: sessionPath,
		...(extraExtensions.length > 0 ? { extraExtensions } : {}),
		...(extraSkills.length > 0 ? { extraSkills } : {}),
	});
	return options.runPi({
		args,
		cwd: options.cwd,
		...(options.runId ? { runId: options.runId } : {}),
		// Its own directory, like the wrap-up's. It used to share the
		// first attempt's, which was harmless while the only shared file
		// was a result nobody had written yet. It stopped being harmless
		// when a journal moved in: the supervisor clears that file before
		// every spawn, so a resume deleted what the attempt it is
		// recovering had recorded, and the continuation prompt tells the
		// reviewer not to make a tool call twice, so it never came back.
		reviewerId: `${options.reviewer.id}${RESUME_SUFFIX}`,
		signal: options.signal,
		onEvent: options.onEvent,
		...(options.timeoutMs !== undefined
			? { timeoutMs: options.timeoutMs }
			: {}),
		...(options.idleTimeoutMs !== undefined
			? { idleTimeoutMs: options.idleTimeoutMs }
			: {}),
	});
}

/**
 * Fold a resume attempt into the initial outcome. The resume
 * is authoritative for the final state, and its usage is
 * added to the initial run's so the reported cost is the
 * true total. A note records whether the resume recovered
 * the reviewer or also failed.
 */
export function mergeResumeOutcome(
	initial: RunReviewerResult,
	resume: RunReviewerResult,
): RunReviewerResult {
	const recovered =
		resume.error === undefined && resume.verification?.ok !== false;
	const note = recovered
		? "Resumed the reviewer from its persisted session after a transient error."
		: "Auto-resume from the persisted session also failed after the transient error; not retried further.";
	const usage = sumReviewerUsage(initial.usage, resume.usage);
	// On a clean recovery the initial attempt's transient-error
	// warning is no longer something the user must act on, and
	// leaving it in reads as though the reviewer failed. Drop
	// just that one warning (regenerated exactly, not
	// fuzzy-matched), keeping any other warnings the first
	// attempt produced.
	const initialError = initial.error;
	const initialWarnings =
		recovered && initialError !== undefined
			? initial.warnings.filter(
					(warning) => warning !== describeReviewerError(initialError),
				)
			: initial.warnings;
	return {
		...resume,
		// Both attempts' journals. A resume replaces the attempt, but
		// not what the attempt wrote down: the continuation prompt tells
		// the reviewer not to repeat tool calls it has already made, so
		// a finding recorded before the drop is never recorded again.
		// Losing it here would take findings from the one path that
		// exists because something went wrong mid-investigation.
		...(initial.journal || resume.journal
			? { journal: [...(initial.journal ?? []), ...(resume.journal ?? [])] }
			: {}),
		warnings: [...initialWarnings, note, ...resume.warnings],
		...(usage ? { usage } : {}),
	};
}

/** Sum two optional usage totals, channel by channel. */
function sumReviewerUsage(
	a: ReviewerUsage | undefined,
	b: ReviewerUsage | undefined,
): ReviewerUsage | undefined {
	if (!a) return b;
	if (!b) return a;
	return {
		tokens: {
			input: a.tokens.input + b.tokens.input,
			output: a.tokens.output + b.tokens.output,
			cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
			cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite,
			total: a.tokens.total + b.tokens.total,
		},
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

function assembleReviewerResult(
	options: RunReviewerOptions,
	result: RunPiResult,
): RunReviewerResult {
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
		? verifiedOutputText(
				verificationForResult.output,
				verificationForResult.outOfBand === true,
			)
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

	// A reviewer's final turn can die on a provider or
	// transport error while the child still exits 0. Name it
	// so the drop is not mistaken for a reviewer that simply
	// never verified, and carry it on the result so the
	// dispatcher can decide whether it is worth resuming.
	if (result.error) warnings.push(describeReviewerError(result.error));

	return {
		reviewerId: options.reviewer.id,
		exitCode: result.exitCode,
		finalAssistantText:
			requiresVerification && verifiedText === null && !hasRunnerCanonicalText
				? ""
				: (verifiedText ?? parsed.finalAssistantText),
		stderr: parsed.stderr,
		warnings,
		...(result.state ? { state: result.state } : {}),
		...(parsed.usage ? { usage: parsed.usage } : {}),
		...(verificationForResult
			? { verification: verificationWithoutOutput(verificationForResult) }
			: {}),
		// Carried whatever else happened, including a blanked answer:
		// what a reviewer wrote down is not conditional on it finishing.
		...(result.journal && result.journal.length > 0
			? { journal: result.journal }
			: {}),
		...(result.journalWarnings && result.journalWarnings.length > 0
			? { journalWarnings: result.journalWarnings }
			: {}),
		...(result.error ? { error: result.error } : {}),
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
	outOfBand = false,
): { readonly text: string | null; readonly warning?: string } | null {
	if (output === undefined) return null;
	const text = JSON.stringify(output, null, 2);
	// Out-of-band output already travelled on a file, past
	// every stream and text cap on purpose. Re-truncating it
	// here would resurrect the very failure the file avoids,
	// so a trusted payload passes through whole.
	if (outOfBand) return { text };
	return truncateBytes(text, MAX_VERIFIED_OUTPUT_BYTES);
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
	// A node child crash leads with an internal frame
	// ("node:internal/child_process:420") and buries the
	// actionable line (an errno like E2BIG, or an "Error:"
	// message) a few lines down. Prefer the meaningful line
	// so a spawn failure names its own cause instead of
	// making the caller guess.
	for (const line of lines) {
		const trimmed = line.trim();
		if (isMeaningfulStderrLine(trimmed)) {
			return truncate(trimmed, STDERR_SNIPPET_MAX);
		}
	}
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		return truncate(trimmed, STDERR_SNIPPET_MAX);
	}
	return "";
}

/**
 * A stderr line that explains a failure: a system errno, a
 * node error code, or an "Error:" message. Internal V8 or
 * node frames and caret markers are not meaningful.
 */
function isMeaningfulStderrLine(line: string): boolean {
	if (!line || line === "^") return false;
	if (line.startsWith("at ") || line.startsWith("node:internal/")) return false;
	return (
		/\b(E2BIG|EMFILE|ENFILE|ENOENT|EACCES|ENOMEM|EAGAIN|ENOSPC|EPIPE)\b/.test(
			line,
		) ||
		/\bERR_[A-Z0-9_]+\b/.test(line) ||
		/\berrno\b/i.test(line) ||
		/^(?:[\w.]*Error)\b/.test(line)
	);
}

/**
 * Tool name a verify pack registers. A subagent calls it to
 * validate its JSON output before ending the run, when the
 * caller attached a pack; the `subagent` tool's `verify`
 * option is what does so. Pi's `--tools`
 * flag is an allowlist that applies to extension tools too,
 * so the dispatcher must include this in any non-empty
 * allowlist or the reviewer would be denied access to a
 * tool the prompt instructs it to use.
 */
export const VERIFY_TOOL_NAME = "verify_output";

/**
 * The tool a reviewer records a finding with, for the same reason.
 *
 * A roster that names a tool palette would otherwise be denied the one
 * tool that makes an interrupted review worth anything, silently, and
 * the reviewer would be told by its contract to call something the
 * allowlist forbids.
 */
export const JOURNAL_TOOL_NAME = "record_finding";

interface ComposeArgsInput {
	readonly spec: SubagentSpec;
	readonly prompt: string;
	readonly systemPrompt?: string;
	readonly isolated?: boolean;
	readonly extraExtensions?: readonly string[];
	readonly extraSkills?: readonly string[];
	/**
	 * When set, reopen this session file (--session) and
	 * continue it instead of starting a fresh ephemeral run
	 * (--no-session). Used by the auto-resume path.
	 */
	readonly resumeSessionPath?: string;
}

/**
 * Write a reviewer prompt to a unique temp file and return
 * its path. Callers pass `@<path>` to pi so the prompt
 * rides a file rather than argv, keeping the spawn under
 * macOS ARG_MAX no matter how large the inlined diffs are.
 * The `.md` extension makes pi read the file as prompt
 * text.
 */
async function writeReviewerPrompt(prompt: string): Promise<string> {
	const path = join(tmpdir(), `pi-reviewer-prompt-${randomUUID()}.md`);
	await writeFile(path, prompt, "utf-8");
	return path;
}

function composeArgs(input: ComposeArgsInput): string[] {
	const args: string[] = [
		"--mode",
		"json",
		...(input.resumeSessionPath
			? ["--session", input.resumeSessionPath]
			: ["--no-session"]),
		"-p",
	];
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
	for (const always of [VERIFY_TOOL_NAME, JOURNAL_TOOL_NAME]) {
		if (!tools.includes(always)) tools.push(always);
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
// the flat `RunReviewerOptions`/`runReviewer` shape. New
// consumers should prefer `SubagentJob` + `runSubagent`.
// The flat names remain because review-integration's ask
// rounds still call them; they were kept for pr-workflow,
// which no longer exists, and inherited rather than
// chosen. The two converge when that caller moves.

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
	/**
	 * Hard wall-clock timeout in milliseconds for this
	 * job's subprocess. Overrides the runner's configured
	 * default. Use for jobs that are expected to run
	 * longer than the global ceiling (deep investigations,
	 * soak tests, multi-step deploys).
	 */
	readonly timeoutMs?: number;
	/**
	 * Idle timeout in milliseconds for this job: how long
	 * the supervisor will wait between supervisor protocol
	 * events before declaring the child stuck. Overrides
	 * the runner's configured default. Bump this when the
	 * subagent's natural workflow contains long bash
	 * commands that stream no progress (gsperf bench runs,
	 * git pushes against a large mirror, gcloud deploys).
	 */
	readonly idleTimeoutMs?: number;
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
	/**
	 * Structured terminal error when the final turn stopped on
	 * a provider or transport failure. A crashed stream still
	 * exits 0, so without this a dropped fleet subagent reads
	 * as a clean completion.
	 */
	readonly error?: ReviewerError;
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
		// Fleet jobs are ephemeral: no session is persisted and a
		// transient drop is not resumed. Resume is a reviewer-path
		// affordance that assumes a verify contract fleet jobs may
		// not have.
		autoResume: false,
		...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}),
		...(job.idleTimeoutMs !== undefined
			? { idleTimeoutMs: job.idleTimeoutMs }
			: {}),
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
		...(result.error ? { error: result.error } : {}),
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
 * injects, since the engine doesn't know which tool name is in
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
