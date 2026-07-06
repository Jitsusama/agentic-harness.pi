/**
 * Round 3 — critique (optional).
 *
 * The same roster that ran round 1 sees the judge's
 * consolidated list and stakes a position on each
 * finding: agree, disagree, qualify, or amplify, with
 * rationale. Critiques annotate findings; they never
 * remove them.
 *
 * Fan-out across the roster is concurrent against a
 * shared worktree, identical in shape to round 1. The
 * judge itself is not invited back; this round is the
 * original reviewers pushing back on the synthesis.
 *
 * Output is a `CritiqueRun` with one
 * `ReviewerCritiqueOutput` per reviewer. Downstream
 * code joins critiques to the consolidated findings by
 * `findingId` to render `agreement.dissent[]` to the
 * user.
 */

import { Value } from "@sinclair/typebox/value";
import type {
	CouncilReviewer,
	ReviewerUsage,
	ReviewerVerification,
} from "../../lib/subagent/subagent.js";
import { isReviewerCancelledError } from "./cancellation.js";
import type { CouncilDispatch, CouncilTarget } from "./council.js";
import {
	type CouncilProgress,
	type CouncilProgressEntry,
	NULL_PROGRESS,
	safelyNotify,
	summarizeStreamActivity,
} from "./council-progress.js";
import type { CouncilRun, FindingLocation } from "./findings.js";
import type { JudgeRun } from "./judge.js";
import { extractJson } from "./parse.js";
import { reviewerOperatingRules } from "./prompt-operating-rules.js";
import {
	reviewCritiqueStandard,
	reviewQualityStandard,
} from "./review-quality-standard.js";
import {
	CritiqueEntry as CritiqueEntrySchema,
	type CritiquePosition,
} from "./schemas.js";
import {
	type ReviewThreadPromptContext,
	renderReviewThreadPromptContext,
	renderThreadRelation,
} from "./thread-context.js";
import { type WorktreeRegistry, worktreeRequestFor } from "./worktree.js";

// Vocabulary type lives in `schemas.ts`. Re-exported
// here so existing call sites that import the type
// from `critique.js` keep working.
export type { CritiquePosition };

/** One reviewer's position on one consolidated finding. */
export interface CritiqueEntry {
	readonly reviewerId: string;
	readonly findingId: number;
	readonly position: CritiquePosition;
	readonly rationale: string;
}

/** One reviewer's critique output. */
export interface ReviewerCritiqueOutput {
	readonly reviewerId: string;
	readonly critiques: CritiqueEntry[];
	readonly warnings: string[];
	/**
	 * Token + cost totals for this reviewer's critique
	 * subagent. May be undefined when the dispatcher did
	 * not surface usage.
	 */
	readonly usage?: ReviewerUsage;
	/** Result of the critique reviewer's verify_output calls, when observed. */
	readonly verification?: ReviewerVerification;
}

/** Result of one critique round. */
export interface CritiqueRun {
	readonly id: string;
	readonly startedAt: string;
	readonly judgeRunId: string;
	readonly reviewerOutputs: ReviewerCritiqueOutput[];
	readonly warnings: string[];
}

/** Inputs to `buildCritiquePrompt`. */
export interface BuildCritiquePromptInput {
	readonly reviewerId: string;
	readonly council: CouncilRun;
	readonly judge: JudgeRun;
	readonly threadContext?: ReviewThreadPromptContext;
	readonly promptAddendum?: string;
}

/** Inputs to `parseCritiqueOutput`. */
export interface CritiqueParseContext {
	readonly runId: string;
	readonly reviewerId: string;
}

/** Output of `parseCritiqueOutput`. */
export interface CritiqueParseResult {
	readonly critiques: CritiqueEntry[];
	readonly warnings: string[];
}

/** Inputs to `runCritique`. */
export interface RunCritiqueOptions {
	readonly runId: string;
	readonly council: CouncilRun;
	readonly judge: JudgeRun;
	readonly roster: readonly CouncilReviewer[];
	readonly target: Pick<CouncilTarget, "owner" | "repo" | "sha" | "branch">;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly threadContext?: ReviewThreadPromptContext;
	readonly progress?: CouncilProgress;
	readonly signal?: AbortSignal;
	/** Provider or repository context appended to critique prompts. */
	readonly promptAddendum?: string;
	/**
	 * Resolve a reviewer's standing charter by id, forwarded to the
	 * critique subagent as its system prompt. Critique reuses the
	 * reviewer personas: the lens rides as the charter while the
	 * critique hat (take a position on each finding) lives in the
	 * task prompt.
	 */
	readonly charterFor?: (reviewerId: string) => string | undefined;
}

/** Inputs to `runOneCritiqueReviewer`. */
export interface RunOneCritiqueReviewerOptions {
	readonly runId: string;
	readonly council: CouncilRun;
	readonly judge: JudgeRun;
	readonly reviewer: CouncilReviewer;
	readonly target: Pick<CouncilTarget, "owner" | "repo" | "sha" | "branch">;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly threadContext?: ReviewThreadPromptContext;
	readonly signal?: AbortSignal;
	/** Provider or repository context appended to the critique prompt. */
	readonly promptAddendum?: string;
	/**
	 * Resolve the reviewer's standing charter by id, forwarded as
	 * the critique subagent's system prompt. Same contract as
	 * {@link RunCritiqueOptions.charterFor}; the retry path honours
	 * it so a retried critique keeps its persona lens.
	 */
	readonly charterFor?: (reviewerId: string) => string | undefined;
	/**
	 * Optional progress observer. A retry is one full-length
	 * critique subagent; the panel renders its activity and, by
	 * capturing the keyboard, is what makes the run cancellable.
	 */
	readonly progress?: CouncilProgress;
}

/**
 * Run a single critique reviewer. Acquires the shared
 * worktree, builds the prompt, dispatches, and parses
 * output. Mirrors the per-reviewer body of `runCritique`
 * but returns one `ReviewerCritiqueOutput` for callers
 * that need to substitute it in place of an earlier
 * attempt.
 */
export async function runOneCritiqueReviewer(
	options: RunOneCritiqueReviewerOptions,
): Promise<ReviewerCritiqueOutput> {
	const progress = options.progress ?? NULL_PROGRESS;
	const progressWarnings: string[] = [];
	const startSnapshot: CouncilProgressEntry[] = [
		{
			reviewer: options.reviewer,
			state: "pending",
			findingCount: 0,
			warnings: [],
			error: "",
			activity: "",
		},
	];
	safelyNotify(() => progress.start(startSnapshot), "start", progressWarnings);
	// finish() restores the editor the panel captured on start();
	// it must run no matter how the retry exits. Guarded to fire once.
	let finished = false;
	const finishOnce = (): void => {
		if (finished) return;
		finished = true;
		safelyNotify(() => progress.finish(), "finish", progressWarnings);
	};
	const onEvent = (event: Record<string, unknown>): void => {
		const activity = summarizeStreamActivity(event);
		if (activity === null) return;
		safelyNotify(
			() => progress.reviewerActivity?.(options.reviewer.id, activity),
			"activity",
			progressWarnings,
		);
	};
	try {
		const handle = await options.registry.ensure(
			worktreeRequestFor(options.target),
		);
		const prompt = buildCritiquePrompt({
			reviewerId: options.reviewer.id,
			council: options.council,
			judge: options.judge,
			...(options.threadContext
				? { threadContext: options.threadContext }
				: {}),
			...(options.promptAddendum
				? { promptAddendum: options.promptAddendum }
				: {}),
		});
		const charter = options.charterFor?.(options.reviewer.id);
		safelyNotify(
			() => progress.reviewerStarted(options.reviewer.id),
			"started",
			progressWarnings,
		);
		const dispatched = await options.dispatch({
			reviewer: options.reviewer,
			prompt,
			cwd: handle.path,
			runId: options.runId,
			signal: options.signal,
			expectedVerificationStage: "critique",
			onEvent,
			...(charter ? { systemPrompt: charter } : {}),
		});
		const parsed = parseCritiqueOutput(dispatched.finalAssistantText, {
			runId: options.runId,
			reviewerId: options.reviewer.id,
		});
		const warnings = [...dispatched.warnings, ...parsed.warnings];
		const noun = parsed.critiques.length === 1 ? "position" : "positions";
		safelyNotify(
			() =>
				progress.reviewerCompleted(options.reviewer.id, {
					reviewerId: options.reviewer.id,
					warnings,
					completedLabel: `${parsed.critiques.length} ${noun}`,
					...(dispatched.usage ? { usage: dispatched.usage } : {}),
				}),
			"completed",
			progressWarnings,
		);
		return {
			reviewerId: options.reviewer.id,
			critiques: parsed.critiques,
			warnings: [...warnings, ...progressWarnings],
			...(dispatched.usage ? { usage: dispatched.usage } : {}),
			...(dispatched.verification
				? { verification: dispatched.verification }
				: {}),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		safelyNotify(
			() => progress.reviewerFailed(options.reviewer.id, message),
			"failed",
			progressWarnings,
		);
		return {
			reviewerId: options.reviewer.id,
			critiques: [],
			warnings: [`Critique dispatch failed: ${message}`, ...progressWarnings],
		};
	} finally {
		finishOnce();
	}
}

/**
 * Render the critique prompt for a single reviewer. The
 * reviewer sees:
 *   - their own round-1 findings (so they recall their
 *     position before reading the synthesis)
 *   - every consolidated finding with id, location,
 *     label, and `raisedBy` attribution
 *   - the four allowed positions and the JSON output
 *     schema
 */
export function buildCritiquePrompt(input: BuildCritiquePromptInput): string {
	const lines: string[] = [];
	lines.push(
		`You are reviewer "${input.reviewerId}" in a multi-model code-review council. ` +
			"A judge has consolidated everyone's round-1 findings into the " +
			"list below. Take a position on EACH consolidated finding by id.",
	);
	lines.push("");
	lines.push("Allowed positions:");
	lines.push("  - agree: the finding is correct as stated.");
	lines.push(
		"  - disagree: the finding is wrong, misleading, or doesn't " +
			"apply. Say why.",
	);
	lines.push(
		"  - qualify: the finding is partially right; narrow or soften " +
			"it. Say how.",
	);
	lines.push(
		"  - amplify: the finding is correct AND undersold; mark it more " +
			"severe or blocking. Say why.",
	);
	lines.push("");
	lines.push(reviewQualityStandard());
	lines.push("");
	lines.push(reviewCritiqueStandard());
	lines.push("");
	lines.push(renderReviewThreadPromptContext(input.threadContext));
	pushPromptAddendum(lines, input.promptAddendum);
	lines.push("");
	lines.push(reviewerOperatingRules());
	lines.push("");
	lines.push("Your round-1 findings (for recall):");
	const own = input.council.reviewerOutputs.find(
		(o) => o.reviewerId === input.reviewerId,
	);
	if (own && own.findings.length > 0) {
		for (const finding of own.findings) {
			lines.push(
				`  [your id=${finding.id}] [${finding.label}] ${finding.subject} ${renderLocation(finding.location)}`,
			);
			lines.push(`    ${finding.discussion}`);
			const relation = renderThreadRelation(finding.threadRelation);
			if (relation !== null) lines.push(`    thread: ${relation}`);
		}
	} else {
		lines.push("  (none)");
	}
	lines.push("");
	lines.push("Consolidated findings to critique:");
	if (input.judge.consolidatedFindings.length === 0) {
		lines.push("  (none)");
	}
	for (const finding of input.judge.consolidatedFindings) {
		const raisedBy = finding.agreement?.raisedBy ?? [];
		const attribution =
			raisedBy.length > 0
				? ` (raised by: ${raisedBy.join(", ")})`
				: " (judge synthesis)";
		lines.push(
			`  [id=${finding.id}] [${finding.label}] ${finding.subject} ${renderLocation(finding.location)}${attribution}`,
		);
		lines.push(`    ${finding.discussion}`);
		const relation = renderThreadRelation(finding.threadRelation);
		if (relation !== null) lines.push(`    thread: ${relation}`);
	}
	lines.push("");
	lines.push(
		"Follow the `pr-workflow-critique-output` skill for your output " +
			"contract: the JSON shape, `position` vocabulary, rationale " +
			"requirements and the `verify_output` self-check protocol. The skill " +
			"is loaded into this subagent. Rely on `verify_output`'s feedback to " +
			"converge on a valid payload before ending your run.",
	);
	return lines.join("\n");
}

function renderLocation(loc: FindingLocation): string {
	switch (loc.kind) {
		case "line":
			return `at ${loc.file}:${loc.start}-${loc.end} (${loc.side})`;
		case "file":
			return `at ${loc.file}`;
		case "global":
			return "(scope)";
	}
}

/**
 * Parse a reviewer's critique response. Resilient: bad
 * entries drop, others are kept. Warnings surface what
 * went wrong.
 */
export function parseCritiqueOutput(
	text: string,
	context: CritiqueParseContext,
): CritiqueParseResult {
	const jsonText = extractJson(text);
	if (jsonText === null) {
		return {
			critiques: [],
			warnings: ["Critique response contained no JSON block"],
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			critiques: [],
			warnings: [`Critique JSON failed to parse: ${message}`],
		};
	}
	if (typeof parsed !== "object" || parsed === null) {
		return {
			critiques: [],
			warnings: ["Critique JSON top-level was not an object"],
		};
	}
	const record = parsed as Record<string, unknown>;
	const rawCritiques = Array.isArray(record.critiques) ? record.critiques : [];

	const critiques: CritiqueEntry[] = [];
	const warnings: string[] = [];
	for (let i = 0; i < rawCritiques.length; i++) {
		const raw = rawCritiques[i];
		if (!Value.Check(CritiqueEntrySchema, raw)) {
			warnings.push(`Critique at index ${i} is malformed; skipped`);
			continue;
		}
		// Schema's `minLength: 1` accepts " "; drop
		// whitespace-only rationales so noise doesn't get
		// promoted into the user-facing critique list.
		if (raw.rationale.trim() === "") {
			warnings.push(`Critique at index ${i} is malformed; skipped`);
			continue;
		}
		critiques.push({
			reviewerId: context.reviewerId,
			findingId: raw.findingId,
			position: raw.position,
			rationale: raw.rationale,
		});
	}
	return { critiques, warnings };
}

function pushPromptAddendum(
	lines: string[],
	addendum: string | undefined,
): void {
	const trimmed = addendum?.trim();
	if (trimmed === undefined || trimmed.length === 0) return;
	lines.push("");
	lines.push("## Provider review context");
	lines.push("");
	lines.push(trimmed);
}

/**
 * Fan out the roster across one shared worktree. Each
 * reviewer's pi subagent runs concurrently. Errors are
 * captured per reviewer (via warnings) rather than
 * aborting the run.
 */
export async function runCritique(
	options: RunCritiqueOptions,
): Promise<CritiqueRun> {
	const startedAt = new Date().toISOString();
	const progress = options.progress ?? NULL_PROGRESS;
	const progressWarnings: string[] = [];
	safelyNotify(
		() =>
			progress.start(
				options.roster.map((reviewer) => ({
					reviewer,
					state: "pending",
					findingCount: 0,
					warnings: [],
					error: "",
					activity: "",
				})),
			),
		"start",
		progressWarnings,
	);

	try {
		const handle = await options.registry.ensure(
			worktreeRequestFor(options.target),
		);

		const promises = options.roster.map(async (reviewer) => {
			safelyNotify(
				() => progress.reviewerStarted(reviewer.id),
				`started(${reviewer.id})`,
				progressWarnings,
			);
			const prompt = buildCritiquePrompt({
				reviewerId: reviewer.id,
				council: options.council,
				judge: options.judge,
				...(options.threadContext
					? { threadContext: options.threadContext }
					: {}),
				...(options.promptAddendum
					? { promptAddendum: options.promptAddendum }
					: {}),
			});
			const charter = options.charterFor?.(reviewer.id);
			try {
				const dispatched = await options.dispatch({
					reviewer,
					prompt,
					cwd: handle.path,
					runId: options.runId,
					signal: options.signal,
					expectedVerificationStage: "critique",
					...(charter ? { systemPrompt: charter } : {}),
					onEvent: (event) => {
						const activity = summarizeStreamActivity(event);
						if (activity === null) return;
						safelyNotify(
							() => progress.reviewerActivity?.(reviewer.id, activity),
							`activity(${reviewer.id})`,
							progressWarnings,
						);
					},
				});
				const parsed = parseCritiqueOutput(dispatched.finalAssistantText, {
					runId: options.runId,
					reviewerId: reviewer.id,
				});
				const output: ReviewerCritiqueOutput = {
					reviewerId: reviewer.id,
					critiques: parsed.critiques,
					warnings: [...dispatched.warnings, ...parsed.warnings],
					...(dispatched.usage ? { usage: dispatched.usage } : {}),
					...(dispatched.verification
						? { verification: dispatched.verification }
						: {}),
				};
				safelyNotify(
					() =>
						progress.reviewerCompleted(reviewer.id, {
							reviewerId: reviewer.id,
							warnings: output.warnings,
							completedLabel: critiqueCompletedLabel(output.critiques.length),
							...(output.usage ? { usage: output.usage } : {}),
						}),
					`completed(${reviewer.id})`,
					progressWarnings,
				);
				return output;
			} catch (error) {
				if (isReviewerCancelledError(error)) {
					safelyNotify(
						() => progress.reviewerCancelled?.(reviewer.id),
						`cancelled(${reviewer.id})`,
						progressWarnings,
					);
				} else {
					const message =
						error instanceof Error ? error.message : String(error);
					safelyNotify(
						() => progress.reviewerFailed(reviewer.id, message),
						`failed(${reviewer.id})`,
						progressWarnings,
					);
				}
				throw error;
			}
		});

		const settled = await Promise.allSettled(promises);
		const reviewerOutputs: ReviewerCritiqueOutput[] = [];
		const runWarnings: string[] = [];
		for (let i = 0; i < settled.length; i++) {
			const result = settled[i];
			if (result.status === "fulfilled") {
				reviewerOutputs.push(result.value);
			} else {
				const reviewerId = options.roster[i].id;
				const cancelled = isReviewerCancelledError(result.reason);
				const message = cancelled
					? "Reviewer cancelled by user."
					: result.reason instanceof Error
						? result.reason.message
						: String(result.reason);
				reviewerOutputs.push({
					reviewerId,
					critiques: [],
					warnings: [
						cancelled ? message : `Critique dispatch failed: ${message}`,
					],
				});
				runWarnings.push(
					cancelled
						? `Reviewer ${reviewerId} cancelled by user.`
						: `Reviewer ${reviewerId} threw: ${message}`,
				);
			}
		}

		return {
			id: options.runId,
			startedAt,
			judgeRunId: options.judge.id,
			reviewerOutputs,
			warnings: [...runWarnings, ...progressWarnings],
		};
	} finally {
		safelyNotify(() => progress.finish(), "finish", progressWarnings);
	}
}

function critiqueCompletedLabel(count: number): string {
	const noun = count === 1 ? "critique" : "critiques";
	return `${count} ${noun}`;
}
