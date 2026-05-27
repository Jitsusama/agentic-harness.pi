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

import type {
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
	readonly thinkingLevel?: "off" | "low" | "medium" | "high";
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
	};
	return { spec, job: jobPayload };
}

/** Per-subagent result in the fleet's output payload. */
export interface FleetSubagentResult {
	readonly id: string;
	readonly finalAssistantText: string;
	readonly warnings: readonly string[];
	readonly state: "complete" | "cancelled" | "failed";
	readonly error?: string;
	readonly usage?: SubagentUsage;
}

/** Aggregate output of a fleet run. */
export interface FleetRunResult {
	readonly runId: string;
	readonly results: readonly FleetSubagentResult[];
	readonly totalUsage?: SubagentUsage;
	readonly warnings: readonly string[];
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
			const message = `pi exited with code ${result.exitCode}`;
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
 * Render the run's outcome as a one-paragraph summary
 * suitable for the tool's text response. The structured
 * `details` payload carries the full per-subagent text;
 * this is for the inline conversation transcript.
 */
export function formatFleetSummary(result: FleetRunResult): string {
	const total = result.results.length;
	const complete = result.results.filter((r) => r.state === "complete").length;
	const failed = result.results.filter((r) => r.state === "failed").length;
	const cancelled = result.results.filter(
		(r) => r.state === "cancelled",
	).length;
	const parts: string[] = [
		`Fleet ${result.runId}: ${complete}/${total} complete`,
	];
	if (failed > 0) parts.push(`${failed} failed`);
	if (cancelled > 0) parts.push(`${cancelled} cancelled`);
	if (result.totalUsage) {
		parts.push(
			`${result.totalUsage.tokens.total.toLocaleString()} tokens, $${result.totalUsage.cost.total.toFixed(4)}`,
		);
	}
	return parts.join(" · ");
}
