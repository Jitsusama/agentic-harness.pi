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
 *
 * What a run is asked and answers is in `run-contract.ts`, how its pi
 * is started in `launch.ts`, its resume and wrap-up in `follow-up.ts`,
 * and how its answer is read in `reviewer-result.ts`. This file runs
 * them in order and re-exports what callers name, so they import from
 * here alone.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { whyUnusableClock, whyUnusableClocks } from "../clock/index.ts";
import { ReviewerArtifactsStore } from "./artifacts.ts";
import {
	dispatchResume,
	dispatchWrapUp,
	mergeResumeOutcome,
	mergeWrapUpOutcome,
	WORTH_ASKING,
	wrapUpReserve,
} from "./follow-up.ts";
import { checkSubagentRuntime } from "./health.ts";
import {
	briefName,
	composeArgs,
	holdBrief,
	reviewerLoadout,
	wholeQuestion,
	writeWhole,
} from "./launch.ts";
import { classifyReviewerError, type ReviewerError } from "./reviewer-error.ts";
import { assembleReviewerResult } from "./reviewer-result.ts";
import type {
	ReviewerUsage,
	ReviewerVerification,
	RunPi,
	RunPiResult,
	RunPiStreamEvent,
	RunReviewerOptions,
	RunReviewerResult,
	StartReviewerOptions,
	SubagentSpec,
} from "./run-contract.ts";
import type { StartedPi } from "./runpi/supervisor.ts";

export {
	mergeResumeOutcome,
	mergeWrapUpOutcome,
	RESUME_SUFFIX,
	WRAP_UP_SUFFIX,
} from "./follow-up.ts";
export { VERIFY_TOOL_NAME } from "./launch.ts";
export type {
	CouncilReviewer,
	ReviewerRunArtifacts,
	ReviewerThinkingLevel,
	ReviewerUsage,
	ReviewerVerification,
	RunPi,
	RunPiResult,
	RunPiStreamEvent,
	RunReviewerOptions,
	RunReviewerResult,
	StartReviewerOptions,
	SubagentSpec,
} from "./run-contract.ts";
export type { ReviewerError } from "./reviewer-error.ts";

/**
 * Synthetic exit code used when `runReviewer` short-
 * circuits because the captured pi binary path is gone.
 * 127 is the POSIX convention for "command not found";
 * downstream code that inspects exit codes treats it
 * the same as any other non-zero failure.
 */
const STALE_RUNTIME_EXIT_CODE = 127;

/**
 * The bounds a per-call timeout override is held to.
 *
 * The floor mirrors the tool schema's
 * `Type.Integer({ minimum: 1000 })` so the library boundary
 * applies the same one regardless of which entry point
 * fires. The ceiling of eight hours covers overnight
 * benchmark soaks, long deep-investigation personas and the
 * slowest reviewer at xhigh thinking on a stack of
 * meaningful PRs, while staying well below Node's
 * 32-bit-signed-int timer ceiling (~24.8 days) where
 * `setTimeout` silently coerces back to 1 ms.
 *
 * Both live in `lib/clock` rather than here, because the
 * runner is the last place they can be applied and the
 * first place they are needed is whoever reads a duration
 * out of a config file. One definition, so a roster cannot
 * accept a clock this would then throw over from inside a
 * round somebody is paying for.
 */

/**
 * Validate a per-call timeout override at the library
 * boundary. Throws when the value is not a finite
 * integer, sits below the floor or exceeds the ceiling.
 * Callers that pass `undefined` are leaving the runner
 * default in place and skip the check.
 */
function validateTimeout(field: string, value: number | undefined): void {
	const why = whyUnusableClock(field, value);
	if (why !== undefined) throw new Error(`Invalid ${field}: ${why}`);
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
	const why = whyUnusableClocks({
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
	});
	if (why !== undefined) throw new Error(`Invalid timeout pair: ${why}`);
}

export { extractUsageFromPiStream } from "./stream.ts";

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
	// Thrown as an Error, carrying the diagnosis as its message. This
	// threw the plain record instead, and every caller that reports a
	// thrown failure reads the message off an Error, so a detached
	// round whose install had gone recorded seven reviewers as
	// "[object Object]": no path, no reason, no restart, on the one
	// path where nobody watched it happen.
	if (runtimeError !== null) {
		throw Object.assign(new Error(runtimeError.message), {
			path: runtimeError.path,
		});
	}

	const { extraExtensions, extraSkills } = reviewerLoadout(options);

	// Kept in the run's own directory, not a temp file. The waiting path
	// removes its brief once nobody needs it, which it can tell and this
	// path cannot: the parent returns before the child has read it. It
	// also makes the question part of the durable record, which for a
	// round that outlives its session is the only place the question
	// survives at all. The brief is the run's, so every reviewer reads
	// it at one path; the reviewer's own copy says what it was asked.
	const store = new ReviewerArtifactsStore(options.stateDir);
	const runId = options.runId ?? `reviewer-${Date.now()}`;
	const paths = await store.ensureReviewerDir(runId, options.reviewer.id);
	const brief = join(
		store.rootPaths(runId).briefsDir,
		`${briefName(options.prompt)}.md`,
	);
	await writeWhole(brief, options.prompt);
	await writeFile(paths.promptPath, wholeQuestion(options), "utf8");

	return options.startPi({
		args: composeArgs({
			spec: options.reviewer,
			prompt: `@${brief}`,
			...(options.ask === undefined ? {} : { ask: options.ask }),
			systemPrompt: options.systemPrompt,
			isolated: options.isolated,
			...(extraExtensions.length > 0 ? { extraExtensions } : {}),
			...(extraSkills.length > 0 ? { extraSkills } : {}),
		}),
		cwd: options.cwd,
		...(options.env === undefined ? {} : { env: options.env }),
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
			// Refused before anything was spawned.
			sessionIds: [],
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
	const { extraExtensions, extraSkills } = reviewerLoadout(options);
	// The prompt carries the whole review payload: every inlined PR
	// diff. On a stack review that runs past macOS ARG_MAX (1,048,576
	// bytes), and a prompt passed on argv crashes the pi child at spawn.
	// Write it to a temp file and hand pi an `@<path>` reference
	// instead, which pi merges into the prompt, so argv stays tiny
	// whatever the diff size. The file is removed once the last run
	// holding it resolves, which is safe only because this path waits
	// for it: `startReviewer` writes into the run's own directory and
	// removes nothing, since its child may not have read the prompt by
	// the time it returns.
	const reserve = wrapUpReserve(options);
	const held = await holdBrief(options.prompt);
	const args = composeArgs({
		spec: options.reviewer,
		prompt: `@${held.path}`,
		...(options.ask === undefined ? {} : { ask: options.ask }),
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
			...(options.env === undefined ? {} : { env: options.env }),
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
		await held.release();
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
 * The tool a reviewer records a finding with, for the same reason.
 *
 * Re-exported from the journal module rather than spelled again,
 * because the side that has to match it is the pack, and the pack
 * should learn its own name without importing the dispatcher that
 * permits it.
 */
export {
	JOURNAL_PACK_PATH,
	JOURNAL_PATH_VAR,
	JOURNAL_TOOL_NAME,
	// biome-ignore lint/correctness/useImportExtensions: Biome reads the .d.mts beside this .mjs as the module and asks for .mjs.mts, a file that doesn't exist.
} from "./runpi/journal.mjs";

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
	/** Every session the subagent's process announced; null when unknown. */
	readonly sessionIds: readonly string[] | null;
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
		sessionIds: result.sessionIds,
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
	const results = settled.map((outcome, index) => {
		if (outcome.status === "fulfilled") return outcome.value;
		const assignment = opts.assignments[index];
		// Never so: settled maps the assignments one to one.
		if (assignment === undefined) throw outcome.reason;
		return synthesizeRejectedResult(assignment.spec, outcome.reason);
	});
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
		// A rejection can come after the process started, so whether it
		// announced a session and billed under it is not known.
		sessionIds: null,
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
