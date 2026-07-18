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
import type { DiffFile } from "../../lib/internal/github/diff.js";
import type {
	CouncilReviewer,
	ReviewerUsage,
	ReviewerVerification,
} from "../../lib/subagent/subagent.js";
import { isReviewerCancelledError } from "./cancellation.js";
import type { CouncilDispatch, CouncilTarget } from "./council.js";
import {
	type CouncilProgress,
	NULL_PROGRESS,
	safelyNotify,
	summarizeStreamActivity,
} from "./council-progress.js";
import type { CouncilRun, Finding, FindingLocation } from "./findings.js";
import { extractJson } from "./parse.js";
import { hasValidInlineAnchor } from "./post.js";
import { reviewerOperatingRules } from "./prompt-operating-rules.js";
import { JudgeFinding, JudgeSelfSignal } from "./schemas.js";
import {
	normalizeFindingSeverities,
	renderAliasNormalizationSummary,
} from "./severity-normalize.js";
import {
	type ReviewThreadPromptContext,
	renderReviewThreadPromptContext,
	renderThreadRelation,
} from "./thread-context.js";
import { type WorktreeRegistry, worktreeRequestFor } from "./worktree.js";

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
	 * Set to "stack-review" when this per-PR run was produced
	 * by a stack review rather than a dedicated per-PR judge.
	 * Lets the findings view label the run's origin and lets a
	 * later per-PR council or judge warn before replacing it.
	 */
	readonly provenance?: "stack-review";
	/**
	 * Token + cost totals for the judge subagent. May be
	 * undefined when the dispatcher didn't surface usage.
	 */
	readonly usage?: ReviewerUsage;
	/** Result of the judge's verify_output calls, when observed. */
	readonly verification?: ReviewerVerification;
}

/** One council reviewer's persona, surfaced to the judge as an exhibit. */
export interface JudgePersonaExhibit {
	readonly reviewerId: string;
	readonly name: string;
	readonly description: string;
}

/** Inputs to `buildJudgePrompt`. */
export interface BuildJudgePromptInput {
	readonly council: CouncilRun;
	readonly threadContext?: ReviewThreadPromptContext;
	readonly promptAddendum?: string;
	/**
	 * The personas the council reviewers wore, keyed to their
	 * reviewer ids. Rendered as exhibits so the judge knows which
	 * lens produced each finding — to weigh, never to adopt. Empty
	 * or omitted when no reviewer wore a persona.
	 */
	readonly personaExhibits?: readonly JudgePersonaExhibit[];
}

/** Inputs to `parseJudgeOutput`. */
export interface JudgeParseContext {
	readonly runId: string;
	readonly judgeReviewerId: string;
	readonly startId: number;
	/**
	 * Council reviewer findings the judge consolidated.
	 * Used to auto-inherit line-kind locations when the
	 * judge collapses sources that all anchored to the
	 * same file. Pass an empty array (or omit) when no
	 * inheritance should be attempted.
	 */
	readonly sourceFindings?: readonly Finding[];
	/**
	 * PR diff used to validate line anchors. When supplied,
	 * line-kind findings whose `start`/`end` falls outside
	 * the diff emit a warning so the user sees the
	 * degrade-to-body risk before `action=post`. Omit to
	 * skip the check (same contract as the council parser).
	 */
	readonly diffFiles?: readonly DiffFile[];
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
	readonly threadContext?: ReviewThreadPromptContext;
	readonly progress?: CouncilProgress;
	readonly signal?: AbortSignal;
	/**
	 * The judge's standing charter (its law), passed to the
	 * subagent as its system prompt. The action resolves it from
	 * `judge.md` or the built-in default; absent it, the judge runs
	 * without a system prompt (the charter lived in the user prompt
	 * before this seam existed).
	 */
	readonly charter?: string;
	/** Provider or repository context appended to the judge prompt. */
	readonly promptAddendum?: string;
	/**
	 * First session-global finding id available to this judge
	 * run. Used only when `allocate` is absent.
	 */
	readonly startId?: number;
	/**
	 * Reserve a contiguous block of `count` finding ids and
	 * return its first id. Called synchronously once the judge
	 * output is parsed, so a judge run concurrent with another
	 * run never overlaps ids.
	 */
	readonly allocate?: (count: number) => number;
	/** Diff used to validate line anchors on judge findings. */
	readonly diffFiles?: readonly DiffFile[];
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
	// The judge's identity, no-persona stance, synthesis discipline
	// and the review standards are its standing charter, supplied as
	// the subagent's system prompt (see judge-charter.ts). This
	// prompt carries only the per-run task: the findings to
	// consolidate, the thread/provider context, and the output
	// contract pointer.
	const lines: string[] = [];
	lines.push(renderReviewThreadPromptContext(input.threadContext));
	pushPromptAddendum(lines, input.promptAddendum);
	lines.push("");
	lines.push(reviewerOperatingRules());
	lines.push("");
	pushPersonaExhibits(lines, input.personaExhibits);
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
			const relation = renderThreadRelation(finding.threadRelation);
			if (relation !== null) lines.push(`    thread: ${relation}`);
		}
	}
	lines.push("");
	lines.push(
		"Follow the `pr-workflow-judge-output` skill for your output contract: " +
			"the JSON shape (optional `selfSignal` plus `findings`), attribution " +
			"fields (`raisedBy`, `sourceFindingIds`), `threadRelation` semantics " +
			"and the `verify_output` self-check protocol. The skill is loaded " +
			"into this subagent. Rely on `verify_output`'s feedback to converge on " +
			"a valid payload before ending your run.",
	);
	lines.push(
		"For each finding, add a short `recommendation`: one decision-oriented " +
			"clause telling the reviewing user what to do about it, for example " +
			"fix before merge, safe to defer, or confirm intent with the author. " +
			"Keep it distinct from `discussion`, which describes the problem.",
	);
	lines.push(
		"Add an `impact`: one clause naming the consequence of leaving the " +
			"finding unaddressed, so the user can weigh the stake. Add a `cluster`: " +
			"a short root-cause label (for example error handling, missing " +
			"validation, race condition) shared by findings that stem from the same " +
			"underlying cause, so related findings group together.",
	);
	return lines.join("\n");
}

function pushPersonaExhibits(
	lines: string[],
	exhibits: readonly JudgePersonaExhibit[] | undefined,
): void {
	if (exhibits === undefined || exhibits.length === 0) return;
	lines.push("## Persona exhibits");
	lines.push(
		"Each reviewer below wore a persona — a lens. These are " +
			"exhibits: weigh what each lens surfaced, but do NOT adopt any " +
			"of them. You hold no lens of your own.",
	);
	for (const exhibit of exhibits) {
		lines.push(
			`- ${exhibit.reviewerId} — ${exhibit.name}: ${exhibit.description}`,
		);
	}
	lines.push("");
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
	const severityNormalization = normalizeFindingSeverities(parsed);
	const record = severityNormalization.value as Record<string, unknown>;
	const selfSignal = toSelfSignal(record.selfSignal);
	const rawFindings = Array.isArray(record.findings) ? record.findings : [];

	const findings: Finding[] = [];
	const warnings: string[] = [...severityNormalization.warnings];
	const aliasSummary = renderAliasNormalizationSummary(
		severityNormalization.aliasCounts,
	);
	if (aliasSummary !== null) warnings.push(aliasSummary);
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
		const inherited = autoInheritLineLocation(raw, context);
		if (inherited.warning) warnings.push(inherited.warning);
		const finding = toJudgedFinding(raw, inherited.location, nextId, context);
		if (context.diffFiles && context.diffFiles.length > 0) {
			const anchorWarning = judgeLineAnchorWarning(finding, context.diffFiles);
			if (anchorWarning) warnings.push(anchorWarning);
		}
		findings.push(finding);
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
	const startedAt = new Date().toISOString();
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
		const handle = await options.registry.ensure(
			worktreeRequestFor(options.target),
		);

		const prompt = buildJudgePrompt({
			council: options.council,
			...(options.threadContext
				? { threadContext: options.threadContext }
				: {}),
			...(options.promptAddendum
				? { promptAddendum: options.promptAddendum }
				: {}),
		});

		safelyNotify(
			() => progress.reviewerStarted(options.judge.id),
			`started(${options.judge.id})`,
			progressWarnings,
		);
		const dispatched = await options.dispatch({
			reviewer: options.judge,
			prompt,
			cwd: handle.path,
			runId: options.runId,
			signal: options.signal,
			expectedVerificationStage: "judge",
			...(options.charter ? { systemPrompt: options.charter } : {}),
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

		const sourceFindings = options.council.reviewerOutputs.flatMap(
			(output) => output.findings,
		);
		// Parse once to count, reserve that many ids at
		// assignment time, then parse from the reserved base.
		const counted = parseJudgeOutput(dispatched.finalAssistantText, {
			runId: options.runId,
			judgeReviewerId: options.judge.id,
			startId: 0,
			sourceFindings,
			...(options.diffFiles ? { diffFiles: options.diffFiles } : {}),
		});
		const startId =
			options.allocate?.(counted.findings.length) ??
			options.startId ??
			nextIdAfterCouncil(options.council);
		const parsed = parseJudgeOutput(dispatched.finalAssistantText, {
			runId: options.runId,
			judgeReviewerId: options.judge.id,
			startId,
			sourceFindings,
			...(options.diffFiles ? { diffFiles: options.diffFiles } : {}),
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
			startedAt,
			judgeReviewerId: options.judge.id,
			selfSignal: parsed.selfSignal,
			consolidatedFindings: parsed.findings,
			warnings: [...warnings, ...progressWarnings],
			...(dispatched.usage ? { usage: dispatched.usage } : {}),
			...(dispatched.verification
				? { verification: dispatched.verification }
				: {}),
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

/**
 * Mirror of the council parser's anchor warning for the
 * judge. When the judge emits or inherits a line-kind
 * location that falls outside the diff hunks, the post
 * step will silently degrade it to a body comment. Surface
 * that early so the user can `verdict=edit` the location
 * before posting.
 */
function judgeLineAnchorWarning(
	finding: Finding,
	diffFiles: readonly DiffFile[],
): string | null {
	if (finding.location.kind !== "line") return null;
	if (hasValidInlineAnchor(finding.location, diffFiles)) return null;
	const { file, start, end } = finding.location;
	return (
		`Judge finding ${finding.id} anchors at ${file}:${start}-${end} ` +
		"but those lines are not in the PR diff hunks; it will degrade to a " +
		"body comment. Use `verdict=edit` with the correct line range to fix."
	);
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
	location: FindingLocation,
	id: number,
	context: JudgeParseContext,
): Finding {
	if (raw.subject.trim() === "" || raw.discussion.trim() === "") {
		throw new Error("unreachable: caller filters whitespace-only entries");
	}
	const category: Finding["category"] =
		location.kind === "global" ? "scope" : "file";
	const agreement = liftAgreement(raw.raisedBy, raw.sourceFindingIds);
	return {
		id,
		location,
		label: raw.label,
		decorations: raw.decorations ?? [],
		subject: raw.subject,
		discussion: raw.discussion,
		category,
		severity: raw.severity,
		...(raw.recommendation ? { recommendation: raw.recommendation } : {}),
		...(raw.impact ? { impact: raw.impact } : {}),
		...(raw.cluster ? { cluster: raw.cluster } : {}),
		confidence: raw.confidence,
		threadRelation: raw.threadRelation,
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
 * Restore line-kind locations the judge collapsed to
 * file-kind when every source finding cited in
 * `sourceFindingIds` already anchored to the same file
 * with line numbers.
 *
 * The collapse is the most common cause of findings
 * degrading to body comments at post time: the judge
 * sees five line-kind sources, picks the broadest unit
 * (the file) and drops the specificity. Parent-side
 * inheritance keeps the lines while letting the judge
 * focus on consolidating discussion.
 *
 * Only `file`-kind judge locations qualify for upgrade.
 * `global`-kind is treated as deliberate (the judge
 * explicitly said "this is a scope-wide concern");
 * `line`-kind is the judge's own anchor and wins.
 * Mixed-file sources or any non-line source leaves the
 * judge's choice in place.
 */
function autoInheritLineLocation(
	raw: JudgeFinding,
	context: JudgeParseContext,
): { location: FindingLocation; warning?: string } {
	if (raw.location.kind !== "file") {
		return { location: raw.location };
	}
	const sourceIds = raw.sourceFindingIds ?? [];
	if (sourceIds.length === 0) {
		return { location: raw.location };
	}
	const sources = context.sourceFindings ?? [];
	const byId = new Map(sources.map((f) => [f.id, f]));
	type LineSide = "old" | "new" | "both";
	const lineSources: Array<{
		start: number;
		end: number;
		side: LineSide;
	}> = [];
	for (const sourceId of sourceIds) {
		const source = byId.get(sourceId);
		if (source?.location.kind !== "line") {
			return { location: raw.location };
		}
		if (source.location.file !== raw.location.file) {
			return { location: raw.location };
		}
		lineSources.push({
			start: source.location.start,
			end: source.location.end,
			side: source.location.side,
		});
	}
	if (lineSources.length === 0) {
		return { location: raw.location };
	}
	const side = lineSources[0].side;
	if (lineSources.some((s) => s.side !== side)) {
		// Sources disagree on diff side. Picking one would
		// silently anchor the consolidated finding to the
		// wrong half of the diff and possibly synthesize a
		// range that doesn't exist on either side. Leave
		// the judge's file-kind alone; the user can split
		// or edit if they want a specific line range.
		return { location: raw.location };
	}
	const start = Math.min(...lineSources.map((s) => s.start));
	const end = Math.max(...lineSources.map((s) => s.end));
	return {
		location: {
			kind: "line",
			file: raw.location.file,
			start,
			end,
			side,
		},
		warning: `Judge finding collapsed to file-kind on ${raw.location.file}; inherited line range ${start}-${end} from sources ${sourceIds.join(", ")}.`,
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
