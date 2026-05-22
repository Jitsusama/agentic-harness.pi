/**
 * Round 2 — judge.
 *
 * The judge round consolidates round-1 reviewer outputs
 * into a single coherent finding list. Duplicate findings
 * across reviewers collapse; agreement metadata
 * (`raisedBy`, `sourceFindingIds`) attaches so the
 * downstream user-synthesis round can see who said what.
 *
 * One judge model, one pi subagent invocation. The judge
 * sees every reviewer's findings (with attribution and
 * source ids) and returns a consolidated list plus a
 * self-signal of its confidence.
 *
 * Prompt baselines are from design 12 §Prompt baseline:
 *   - Priority-Based Curation (severity ordering)
 *   - Balanced Output (cap praise; warn against
 *     suggestion overload)
 *   - Active Synthesis (consolidate, don't concatenate)
 */

import { Value } from "@sinclair/typebox/value";
import { isReviewerCancelledError } from "./cancellation.js";
import type { CouncilDispatch, CouncilTarget } from "./council.js";
import {
	type CouncilProgress,
	NULL_PROGRESS,
	safelyNotify,
	summarizeStreamActivity,
} from "./council-progress.js";
import type { CouncilRun, Finding, FindingLocation } from "./findings.js";
import { reviewerOperatingRules } from "./prompt-operating-rules.js";
import {
	reviewQualityStandard,
	reviewSynthesisStandard,
} from "./review-quality-standard.js";
import type { CouncilReviewer, ReviewerUsage } from "./reviewer.js";
import { JudgeFinding, JudgeOutput, JudgeSelfSignal } from "./schemas.js";
import type { WorktreeRegistry } from "./worktree.js";

// Judge self-signal lives in schemas.ts as the
// authoritative shape. Re-exported here so existing
// call sites keep importing it from `judge.js`.
export type { JudgeSelfSignal };

/** Result of one judge round. */
export interface JudgeRun {
	readonly id: string;
	readonly startedAt: string;
	readonly judgeReviewerId: string;
	readonly selfSignal: JudgeSelfSignal | null;
	readonly consolidatedFindings: Finding[];
	readonly warnings: string[];
	/**
	 * Token + cost totals for the judge subagent. May be
	 * undefined when the dispatcher didn't surface usage.
	 */
	readonly usage?: ReviewerUsage;
}

/** Inputs to `buildJudgePrompt`. */
export interface BuildJudgePromptInput {
	readonly council: CouncilRun;
}

/** Inputs to `parseJudgeOutput`. */
export interface JudgeParseContext {
	readonly runId: string;
	readonly judgeReviewerId: string;
	readonly startId: number;
}

/** Output of `parseJudgeOutput`. */
export interface JudgeParseResult {
	readonly selfSignal: JudgeSelfSignal | null;
	readonly findings: Finding[];
	readonly warnings: string[];
}

/** Inputs to `runJudge`. */
export interface RunJudgeOptions {
	readonly runId: string;
	readonly council: CouncilRun;
	readonly judge: CouncilReviewer;
	readonly target: Pick<CouncilTarget, "owner" | "repo" | "sha" | "branch">;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly progress?: CouncilProgress;
	readonly signal?: AbortSignal;
	/** First session-global finding id available to this judge run. */
	readonly startId?: number;
}

/**
 * Render the judge prompt from a finished CouncilRun.
 *
 * The prompt presents each round-1 finding with its
 * reviewer attribution and source id so the judge can
 * cite them in `sourceFindingIds`. Output schema is
 * documented inline in JSON so the model echoes it.
 */
export function buildJudgePrompt(input: BuildJudgePromptInput): string {
	const lines: string[] = [];
	lines.push(
		"You are the judge in a multi-reviewer code-review council. " +
			"You receive each reviewer's findings on the same pull request " +
			"and must synthesize them into ONE consolidated list. Merge " +
			"similar findings, tighten prose, and reconcile conflicting " +
			"decorations.",
	);
	lines.push("");
	lines.push("Discipline:");
	lines.push(
		"- Synthesize, do not concatenate. Two reviewers raising the " +
			"same issue become ONE consolidated finding listing both in " +
			"`raisedBy`.",
	);
	lines.push(
		"- Priority order: Security → Correctness → Architecture → " +
			"Performance → API stability → Tests → Style.",
	);
	lines.push(
		"- Cap `praise` findings at 2–3 across the whole consolidated " +
			"list. Suggestion overload (>8 on a single file) is a smell; " +
			"prefer dropping noise to keeping it.",
	);
	lines.push(
		"- Favour keep over drop when uncertain. The user reviews next " +
			"and will dismiss noise; you cannot resurface what you drop.",
	);
	lines.push("");
	lines.push(reviewQualityStandard());
	lines.push("");
	lines.push(reviewSynthesisStandard());
	lines.push("");
	lines.push(reviewerOperatingRules());
	lines.push("");
	lines.push("Round 1 findings from the reviewers:");
	for (const output of input.council.reviewerOutputs) {
		lines.push("");
		lines.push(`▸ Reviewer ${output.reviewerId}:`);
		if (output.findings.length === 0) {
			lines.push("  (no findings)");
			continue;
		}
		for (const finding of output.findings) {
			const loc = renderLocation(finding.location);
			lines.push(
				`  [id=${finding.id}] [${finding.label}] ${finding.subject} ${loc}`,
			);
			lines.push(`    ${finding.discussion}`);
		}
	}
	lines.push("");
	lines.push(
		"Respond with a single fenced JSON block. No prose outside the block. " +
			"The object has an optional `selfSignal` and a `findings` array. " +
			"Each finding's core shape (location, label, subject, discussion, " +
			"plus optional decorations, severity, confidence) matches round 1. " +
			"On top of that the judge attaches optional `raisedBy` (list of " +
			"reviewer ids that surfaced this point) and `sourceFindingIds` (the " +
			"round-1 ids you consolidated). Omit those two fields for a finding " +
			"the judge surfaced on its own.",
	);
	lines.push("");
	lines.push("## JSON Schema");
	lines.push(
		"Your output must match this JSON Schema exactly. The same schema is " +
			"used by the `verify_output` tool you'll call below and by the parent " +
			"parser, so anything that passes the verifier will be accepted.",
	);
	lines.push("```json");
	lines.push(JSON.stringify(JudgeOutput, null, 2));
	lines.push("```");
	lines.push("");
	lines.push("## Self-verify before ending");
	lines.push(
		"Before you finish your run, call the `verify_output` tool with " +
			'stage: "judge" and `output` set to the object you intend to emit. ' +
			"The tool returns `ok: true` with the parsed finding count, or `ok: " +
			"false` with a list of {path, message} errors. If errors are reported, " +
			"fix the offending fields and call `verify_output` again. Only emit " +
			"your final fenced JSON block (and end the run) once the verifier " +
			"returns `ok: true`. If the verifier keeps reporting the same error " +
			"after three attempts, emit your best attempt and the parent will " +
			"surface the warnings.",
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
 * Parse the judge's response into a consolidated finding
 * list plus the self-signal. Resilient: bad fields drop
 * rather than abort.
 */
export function parseJudgeOutput(
	text: string,
	context: JudgeParseContext,
): JudgeParseResult {
	const jsonText = extractJson(text);
	if (jsonText === null) {
		return {
			selfSignal: null,
			findings: [],
			warnings: ["Judge response contained no JSON block"],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			selfSignal: null,
			findings: [],
			warnings: [`Judge JSON failed to parse: ${message}`],
		};
	}

	if (typeof parsed !== "object" || parsed === null) {
		return {
			selfSignal: null,
			findings: [],
			warnings: ["Judge JSON top-level was not an object"],
		};
	}
	const record = parsed as Record<string, unknown>;
	const selfSignal = toSelfSignal(record.selfSignal);
	const rawFindings = Array.isArray(record.findings) ? record.findings : [];

	const findings: Finding[] = [];
	const warnings: string[] = [];
	let nextId = context.startId;
	for (let i = 0; i < rawFindings.length; i++) {
		const raw = rawFindings[i];
		if (!Value.Check(JudgeFinding, raw)) {
			warnings.push(`Judge finding at index ${i} is malformed; skipped`);
			continue;
		}
		// Schema accepts " " (length 1); drop trim-empty.
		if (raw.subject.trim() === "" || raw.discussion.trim() === "") {
			warnings.push(`Judge finding at index ${i} is malformed; skipped`);
			continue;
		}
		findings.push(toJudgedFinding(raw, nextId, context));
		nextId++;
	}

	return { selfSignal, findings, warnings };
}

/**
 * Run the judge: provision (or reuse) the worktree,
 * dispatch one pi subagent with the judge prompt, parse
 * the result. Returns a `JudgeRun` even on partial
 * failure so callers can inspect warnings.
 */
export async function runJudge(options: RunJudgeOptions): Promise<JudgeRun> {
	const progress = options.progress ?? NULL_PROGRESS;
	const progressWarnings: string[] = [];
	safelyNotify(
		() =>
			progress.start([
				{
					reviewer: options.judge,
					state: "pending",
					findingCount: 0,
					warnings: [],
					error: "",
					activity: "",
				},
			]),
		"start",
		progressWarnings,
	);
	try {
		const handle = await options.registry.ensure({
			owner: options.target.owner,
			repo: options.target.repo,
			sha: options.target.sha,
			...(options.target.branch ? { branch: options.target.branch } : {}),
		});

		const prompt = buildJudgePrompt({ council: options.council });

		const startId = options.startId ?? nextIdAfterCouncil(options.council);

		safelyNotify(
			() => progress.reviewerStarted(options.judge.id),
			`started(${options.judge.id})`,
			progressWarnings,
		);
		const dispatched = await options.dispatch({
			reviewer: options.judge,
			prompt,
			cwd: handle.path,
			signal: options.signal,
			onEvent: (event) => {
				const activity = summarizeStreamActivity(event);
				if (activity === null) return;
				safelyNotify(
					() => progress.reviewerActivity?.(options.judge.id, activity),
					`activity(${options.judge.id})`,
					progressWarnings,
				);
			},
		});

		const parsed = parseJudgeOutput(dispatched.finalAssistantText, {
			runId: options.runId,
			judgeReviewerId: options.judge.id,
			startId,
		});
		const warnings = [
			...dispatched.warnings,
			...parsed.warnings,
			...progressWarnings,
		];
		safelyNotify(
			() =>
				progress.reviewerCompleted(options.judge.id, {
					reviewerId: options.judge.id,
					findings: parsed.findings,
					warnings,
					...(dispatched.usage ? { usage: dispatched.usage } : {}),
				}),
			`completed(${options.judge.id})`,
			progressWarnings,
		);

		return {
			id: options.runId,
			startedAt: new Date().toISOString(),
			judgeReviewerId: options.judge.id,
			selfSignal: parsed.selfSignal,
			consolidatedFindings: parsed.findings,
			warnings: [...warnings, ...progressWarnings],
			...(dispatched.usage ? { usage: dispatched.usage } : {}),
		};
	} catch (error) {
		if (isReviewerCancelledError(error)) {
			safelyNotify(
				() => progress.reviewerCancelled?.(options.judge.id),
				`cancelled(${options.judge.id})`,
				progressWarnings,
			);
		} else {
			const message = error instanceof Error ? error.message : String(error);
			safelyNotify(
				() => progress.reviewerFailed(options.judge.id, message),
				`failed(${options.judge.id})`,
				progressWarnings,
			);
		}
		throw error;
	} finally {
		safelyNotify(() => progress.finish(), "finish", progressWarnings);
	}
}

function nextIdAfterCouncil(run: CouncilRun): number {
	let max = 0;
	for (const output of run.reviewerOutputs) {
		for (const finding of output.findings) {
			if (finding.id > max) max = finding.id;
		}
	}
	return max + 1;
}

function extractJson(text: string): string | null {
	const fenced = text.match(/```json\s*\n([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();
	const objectStart = text.indexOf("{");
	if (objectStart === -1) return null;
	return text.slice(objectStart);
}

function toSelfSignal(raw: unknown): JudgeSelfSignal | null {
	if (raw === undefined) return null;
	if (!Value.Check(JudgeSelfSignal, raw)) return null;
	return raw;
}

/**
 * Build a `Finding` from a schema-validated judge raw
 * entry. The schema guarantees core fields are
 * well-formed; this step stamps id, origin, derives
 * category, and lifts agreement metadata into the
 * `agreement` shape when both arrays are present.
 */
function toJudgedFinding(
	raw: JudgeFinding,
	id: number,
	context: JudgeParseContext,
): Finding {
	if (raw.subject.trim() === "" || raw.discussion.trim() === "") {
		throw new Error("unreachable: caller filters whitespace-only entries");
	}
	const category: Finding["category"] =
		raw.location.kind === "global" ? "scope" : "file";
	const agreement = liftAgreement(raw.raisedBy, raw.sourceFindingIds);
	return {
		id,
		location: raw.location,
		label: raw.label,
		decorations: raw.decorations ?? [],
		subject: raw.subject,
		discussion: raw.discussion,
		category,
		severity: raw.severity,
		confidence: raw.confidence,
		origin: {
			kind: "judge",
			runId: context.runId,
			judgeReviewerId: context.judgeReviewerId,
		},
		state: "draft",
		...(agreement !== null ? { agreement } : {}),
	};
}

/**
 * Lift schema-valid agreement arrays into the optional
 * `agreement` shape. We attach agreement only when at
 * least one piece of metadata is non-empty; an empty
 * raisedBy + empty sourceFindingIds carries no signal.
 */
function liftAgreement(
	raisedBy: readonly string[] | undefined,
	sourceFindingIds: readonly number[] | undefined,
): { raisedBy: string[]; sourceFindingIds: number[] } | null {
	const rb = raisedBy ?? [];
	const sids = sourceFindingIds ?? [];
	if (rb.length === 0 && sids.length === 0) return null;
	return { raisedBy: [...rb], sourceFindingIds: [...sids] };
}
