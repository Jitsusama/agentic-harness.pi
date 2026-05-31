/**
 * Fleet orchestrator.
 *
 * Takes a list of {@link SubagentJob} specs paired with
 * subagent identities, fans them out through the engine's
 * {@link runSubagent}, threads progress and cancellation
 * through the per-assignment hooks, and aggregates the
 * results into a single payload for the tool to return.
 *
 * The engine's bare {@link runFleet} fan-out is fine for
 * library consumers that just want concurrent work; the
 * tool needs more: per-subagent cancellation registration,
 * live activity hints derived from the JSON stream, error
 * containment per assignment, total-usage aggregation.
 * Composing those concerns lives here rather than in
 * `lib/subagent/`.
 */

import { ReviewerArtifactsStore } from "../../lib/subagent/artifacts.js";
import type {
	ReviewerThinkingLevel,
	RunPi,
	SubagentJob,
	SubagentRunResult,
	SubagentSpec,
	SubagentUsage,
} from "../../lib/subagent/subagent.js";
import { runSubagent } from "../../lib/subagent/subagent.js";
import {
	type FleetCancellationRegistry,
	isSubagentCancelledError,
	SubagentCancelledError,
} from "./cancellation.js";
import {
	type FleetProgress,
	type FleetProgressEntry,
	NULL_FLEET_PROGRESS,
	safelyNotify,
	summarizeFleetActivity,
} from "./progress.js";

/** One subagent's assignment inside a fleet run. */
export interface FleetAssignment {
	readonly spec: SubagentSpec;
	readonly job: SubagentJob;
}

/** Raw job parameter shape as it arrives from the tool call. */
export interface ToolJobInput {
	readonly id: string;
	readonly model?: string;
	readonly thinkingLevel?: ReviewerThinkingLevel;
	readonly tools?: readonly string[];
	readonly cwd: string;
	readonly systemPrompt?: string;
	readonly userPrompt: string;
	readonly isolated?: boolean;
	readonly extraExtensions?: readonly string[];
	readonly extraSkills?: readonly string[];
	readonly verify?: {
		readonly extensionPath: string;
		readonly skillPath?: string;
	};
	readonly timeoutMs?: number;
	readonly idleTimeoutMs?: number;
}

/**
 * Translate the tool's flat job payload into the engine's
 * (spec, job) pair. Pinning the isolation default here
 * (rather than at the registerTool boundary) keeps the
 * mapping testable.
 *
 * Tool-side default for `isolated` is `true` — fleet use
 * cases want a clean slate; the library default stays
 * `false` to serve pr-workflow's full-inheritance
 * reviewers. Callers opt out when they want their ambient
 * pi setup to bleed in.
 */
export function buildAssignment(job: ToolJobInput): FleetAssignment {
	const spec: SubagentSpec = {
		id: job.id,
		...(job.model ? { model: job.model } : {}),
		...(job.thinkingLevel ? { thinkingLevel: job.thinkingLevel } : {}),
		...(job.tools ? { tools: job.tools } : {}),
	};
	const isolated = job.isolated ?? true;
	const jobPayload: SubagentJob = {
		userPrompt: job.userPrompt,
		cwd: job.cwd,
		isolated,
		...(job.systemPrompt ? { systemPrompt: job.systemPrompt } : {}),
		...(job.extraExtensions ? { extraExtensions: job.extraExtensions } : {}),
		...(job.extraSkills ? { extraSkills: job.extraSkills } : {}),
		...(job.verify
			? {
					verify: job.verify.skillPath
						? {
								extensionPath: job.verify.extensionPath,
								skillPath: job.verify.skillPath,
							}
						: { extensionPath: job.verify.extensionPath },
				}
			: {}),
		...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}),
		...(job.idleTimeoutMs !== undefined
			? { idleTimeoutMs: job.idleTimeoutMs }
			: {}),
	};
	return { spec, job: jobPayload };
}

/** Per-subagent result in the fleet's output payload. */
export interface FleetSubagentResult {
	readonly id: string;
	readonly finalAssistantText: string;
	readonly warnings: readonly string[];
	readonly state: "complete" | "cancelled" | "failed";
	/**
	 * Short human-readable failure reason. For `state:
	 * "failed"` it includes the exit code plus a tail of
	 * stderr (typically the last few non-blank lines) so
	 * a caller can act on the reason without opening the
	 * supervisor's on-disk artifacts.
	 */
	readonly error?: string;
	/**
	 * Bounded stderr tail captured from the failed
	 * subagent. Present on `state: "failed"` when the
	 * child process wrote anything to stderr. The
	 * supervised path (used by every fleet run) caps this
	 * at the supervisor's `DEFAULT_STDERR_TAIL_BYTES`
	 * window (8 KB by default), so on long-running
	 * failures only the most recent bytes survive here.
	 * The full stderr stream is preserved on disk at
	 * `<runDir>/reviewers/<id>/stderr.log`; read that when
	 * truncation matters.
	 */
	readonly stderr?: string;
	readonly usage?: SubagentUsage;
	/**
	 * On-disk path to this subagent's durable `result.json`
	 * (full `finalAssistantText`, exit code, usage). Set when
	 * the caller resolves it from the artifact store. Lets a
	 * reader open the complete output directly instead of
	 * parsing it back out of the tool's `details` payload.
	 */
	readonly resultPath?: string;
}

/** Last non-blank stderr lines, capped, for inline display in `error`. */
const STDERR_SUMMARY_LINES = 3;
const STDERR_SUMMARY_CHARS = 240;

export function summarizeStderrTail(stderr: string): string {
	if (!stderr) return "";
	const lines = stderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return "";
	const tail = lines.slice(-STDERR_SUMMARY_LINES).join(" — ");
	return tail.length > STDERR_SUMMARY_CHARS
		? `${tail.slice(0, STDERR_SUMMARY_CHARS - 3)}...`
		: tail;
}

/** Aggregate output of a fleet run. */
export interface FleetRunResult {
	readonly runId: string;
	readonly results: readonly FleetSubagentResult[];
	readonly totalUsage?: SubagentUsage;
	readonly warnings: readonly string[];
	/**
	 * On-disk directory holding this run's durable artifacts
	 * (one `reviewers/<id>/` subdir per subagent). Set when the
	 * caller resolves it from the artifact store, so the run's
	 * full output is discoverable without spelunking.
	 */
	readonly runDir?: string;
}

/** Inputs the orchestrator needs to dispatch a fleet. */
export interface DispatchFleetOptions {
	readonly runId: string;
	readonly assignments: readonly FleetAssignment[];
	readonly runPi: RunPi;
	readonly cancellations: FleetCancellationRegistry;
	readonly progress?: FleetProgress;
	readonly signal?: AbortSignal;
}

/**
 * Run a fleet of subagents, wiring cancellation and
 * progress along the way. Failures inside a single
 * assignment surface as that subagent's `failed` state
 * (or `cancelled` when the user pulled the trigger) and
 * never abort siblings. Returns once every assignment has
 * settled.
 */
export async function dispatchFleet(
	opts: DispatchFleetOptions,
): Promise<FleetRunResult> {
	assertUniqueIds(opts.assignments);
	const warnings: string[] = [];
	const progress = opts.progress ?? NULL_FLEET_PROGRESS;
	const run = opts.cancellations.beginRun();
	const initial: FleetProgressEntry[] = opts.assignments.map(({ spec }) => ({
		spec,
		state: "pending",
		warnings: [],
		error: "",
		activity: "",
	}));
	safelyNotify(() => progress.start(initial), "start", warnings);
	try {
		const results = await Promise.all(
			opts.assignments.map((assignment) =>
				runOneAssignment(assignment, opts, run, progress, warnings),
			),
		);
		const totalUsage = aggregateUsage(results);
		return {
			runId: opts.runId,
			results,
			...(totalUsage ? { totalUsage } : {}),
			warnings,
		};
	} finally {
		run.end();
		safelyNotify(() => progress.finish(), "finish", warnings);
	}
}

async function runOneAssignment(
	assignment: FleetAssignment,
	opts: DispatchFleetOptions,
	run: ReturnType<FleetCancellationRegistry["beginRun"]>,
	progress: FleetProgress,
	warnings: string[],
): Promise<FleetSubagentResult> {
	const registration = run.register(assignment.spec, opts.signal);
	safelyNotify(
		() => progress.subagentStarted(assignment.spec.id),
		"subagentStarted",
		warnings,
	);
	try {
		const result = await runSubagent({
			spec: assignment.spec,
			job: assignment.job,
			runPi: opts.runPi,
			runId: opts.runId,
			signal: registration.signal,
			onEvent: (event) => {
				const activity = summarizeFleetActivity(event);
				if (activity === null) return;
				safelyNotify(
					() => progress.subagentActivity?.(assignment.spec.id, activity),
					"subagentActivity",
					warnings,
				);
			},
		});
		if (registration.wasCancelledByUser()) {
			throw new SubagentCancelledError(assignment.spec.id);
		}
		if (result.exitCode !== 0) {
			// pi exited non-zero (1, 124 timeout, 130 SIGINT,
			// etc.). `runSubagent` captures the exit code on the
			// result rather than throwing, so the fleet has to
			// translate that into a failed state explicitly.
			//
			// stderrTail is inlined into `error` so the calling
			// agent can act on the reason without spelunking on
			// disk. The bounded stderr tail is preserved on the
			// result for diagnostic UIs; the full untruncated
			// stream is on disk at <runDir>/reviewers/<id>/stderr.log.
			const stderrTail = summarizeStderrTail(result.stderr);
			const message = stderrTail
				? `pi exited with code ${result.exitCode}: ${stderrTail}`
				: `pi exited with code ${result.exitCode}`;
			safelyNotify(
				() => progress.subagentFailed(assignment.spec.id, message),
				"subagentFailed",
				warnings,
			);
			return {
				id: assignment.spec.id,
				finalAssistantText: result.finalAssistantText,
				warnings: result.warnings,
				state: "failed",
				error: message,
				...(result.stderr ? { stderr: result.stderr } : {}),
				...(result.usage ? { usage: result.usage } : {}),
			};
		}
		safelyNotify(
			() =>
				progress.subagentCompleted(assignment.spec.id, {
					subagentId: assignment.spec.id,
					warnings: result.warnings,
					...(result.usage ? { usage: result.usage } : {}),
				}),
			"subagentCompleted",
			warnings,
		);
		return formatSuccess(result);
	} catch (error) {
		if (isSubagentCancelledError(error) || registration.wasCancelledByUser()) {
			safelyNotify(
				() => progress.subagentCancelled?.(assignment.spec.id),
				"subagentCancelled",
				warnings,
			);
			return {
				id: assignment.spec.id,
				finalAssistantText: "",
				warnings: [],
				state: "cancelled",
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		safelyNotify(
			() => progress.subagentFailed(assignment.spec.id, message),
			"subagentFailed",
			warnings,
		);
		return {
			id: assignment.spec.id,
			finalAssistantText: "",
			warnings: [],
			state: "failed",
			error: message,
		};
	} finally {
		registration.finish();
	}
}

/**
 * Reject the fleet before dispatch when two assignments
 * share an id. The cancellation registry keys active
 * subagents by id; duplicates would overwrite each other,
 * making cancel-one reach only the survivor and silently
 * leaking the loser's process. The progress panel and any
 * supervisor artifacts would also collide. Caller fixes
 * the ids and resubmits.
 */
function assertUniqueIds(assignments: readonly FleetAssignment[]): void {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const { spec } of assignments) {
		if (seen.has(spec.id)) duplicates.add(spec.id);
		else seen.add(spec.id);
	}
	if (duplicates.size === 0) return;
	const names = [...duplicates].map((id) => `"${id}"`).join(", ");
	throw new Error(
		`Duplicate subagent id(s) in fleet: ${names}. Each job must have a unique id.`,
	);
}

function formatSuccess(result: SubagentRunResult): FleetSubagentResult {
	return {
		id: result.subagentId,
		finalAssistantText: result.finalAssistantText,
		warnings: result.warnings,
		state: "complete",
		...(result.usage ? { usage: result.usage } : {}),
	};
}

function aggregateUsage(
	results: readonly FleetSubagentResult[],
): SubagentUsage | undefined {
	const tallied = results.reduce<SubagentUsage | null>((acc, r) => {
		if (!r.usage) return acc;
		if (!acc) return r.usage;
		return {
			tokens: {
				input: acc.tokens.input + r.usage.tokens.input,
				output: acc.tokens.output + r.usage.tokens.output,
				cacheRead: acc.tokens.cacheRead + r.usage.tokens.cacheRead,
				cacheWrite: acc.tokens.cacheWrite + r.usage.tokens.cacheWrite,
				total: acc.tokens.total + r.usage.tokens.total,
			},
			cost: {
				input: acc.cost.input + r.usage.cost.input,
				output: acc.cost.output + r.usage.cost.output,
				cacheRead: acc.cost.cacheRead + r.usage.cost.cacheRead,
				cacheWrite: acc.cost.cacheWrite + r.usage.cost.cacheWrite,
				total: acc.cost.total + r.usage.cost.total,
			},
		};
	}, null);
	return tallied ?? undefined;
}

/**
 * Render the run's outcome as a multi-line summary
 * suitable for the tool's text response. The structured
 * `details` payload carries the full per-subagent text;
 * this view is for the inline conversation transcript.
 *
 * Failed subagents get their own line with a short reason
 * inline so the user (and the calling agent) can see WHY
 * a run failed without opening the supervisor's on-disk
 * artifacts. The bounded stderr tail stays on the
 * per-subagent result for diagnostic UIs; the full
 * untruncated stream is on disk at the supervisor's
 * `<runDir>/reviewers/<id>/stderr.log`.
 */
/**
 * Enrich a fleet result with the on-disk paths of its durable
 * artifacts: the run directory and each subagent's `result.json`,
 * derived from the artifact store under `stateDir`. Callers read
 * the full output directly from these paths rather than parsing it
 * out of the payload. Pure: it constructs path strings and touches
 * no filesystem, so a missing run dir surfaces only when a caller
 * reads it.
 */
export function locateArtifacts(
	stateDir: string,
	result: FleetRunResult,
): FleetRunResult {
	const store = new ReviewerArtifactsStore(stateDir);
	return {
		...result,
		runDir: store.rootPaths(result.runId).runDir,
		results: result.results.map((r) => ({
			...r,
			resultPath: store.paths(result.runId, r.id).resultPath,
		})),
	};
}

export function formatFleetSummary(result: FleetRunResult): string {
	const total = result.results.length;
	const complete = result.results.filter((r) => r.state === "complete").length;
	const failures = result.results.filter((r) => r.state === "failed");
	const cancelled = result.results.filter(
		(r) => r.state === "cancelled",
	).length;
	const headerParts: string[] = [
		`Fleet ${result.runId}: ${complete}/${total} complete`,
	];
	if (failures.length > 0) headerParts.push(`${failures.length} failed`);
	if (cancelled > 0) headerParts.push(`${cancelled} cancelled`);
	if (result.totalUsage) {
		headerParts.push(
			`${result.totalUsage.tokens.total.toLocaleString()} tokens, $${result.totalUsage.cost.total.toFixed(4)}`,
		);
	}
	const lines: string[] = [headerParts.join(" · ")];
	for (const failure of failures) {
		const reason = failure.error ?? "unknown failure";
		lines.push(`  ✗ ${failure.id}: ${reason}`);
	}
	// Surface where the full per-subagent output lives. Without this
	// the summary reads as the whole result, when in fact each
	// subagent's complete text is on disk (and in the tool's details
	// payload). Point the reader at the durable artifacts.
	if (result.runDir) {
		lines.push(`  full output: ${result.runDir}`);
		for (const r of result.results) {
			if (r.resultPath) lines.push(`    ${r.id} → ${r.resultPath}`);
		}
	}
	return lines.join("\n");
}
