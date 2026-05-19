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

import type { CouncilDispatch, CouncilTarget } from "./council.js";
import type {
	ConventionalLabel,
	CouncilRun,
	Finding,
	FindingAgreement,
	FindingLocation,
	FindingSeverity,
} from "./findings.js";
import type { CouncilReviewer, ReviewerUsage } from "./reviewer.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Judge self-signal of confidence in the consolidation. */
export interface JudgeSelfSignal {
	readonly confidence: "low" | "medium" | "high";
	readonly rationale: string;
}

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
	readonly target: Pick<CouncilTarget, "owner" | "repo" | "sha">;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly signal?: AbortSignal;
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
		"Respond with a single fenced JSON block. Schema (omit fields " +
			"that don't apply):",
	);
	lines.push("```json");
	lines.push("{");
	lines.push('  "selfSignal": {');
	lines.push('    "confidence": "low" | "medium" | "high",');
	lines.push('    "rationale": "one-line reason"');
	lines.push("  },");
	lines.push('  "findings": [');
	lines.push("    {");
	lines.push('      "location": { "kind": "line"|"file"|"global", ... },');
	lines.push('      "label": "praise"|"nitpick"|"suggestion"|"issue"|...,');
	lines.push('      "decorations": ["blocking", ...],');
	lines.push('      "subject": "...",');
	lines.push('      "discussion": "...",');
	lines.push('      "severity": "critical"|"medium"|"minor",');
	lines.push('      "raisedBy": ["reviewerId", ...],');
	lines.push('      "sourceFindingIds": [1, 5, ...]');
	lines.push("    }");
	lines.push("  ]");
	lines.push("}");
	lines.push("```");
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

const VALID_LABELS: ReadonlySet<ConventionalLabel> = new Set([
	"praise",
	"nitpick",
	"suggestion",
	"issue",
	"todo",
	"question",
	"thought",
	"chore",
	"note",
	"typo",
	"polish",
	"quibble",
]);

const VALID_SEVERITIES: ReadonlySet<FindingSeverity> = new Set([
	"critical",
	"medium",
	"minor",
]);

const VALID_CONFIDENCES = new Set(["low", "medium", "high"] as const);

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
		const finding = toJudgedFinding(rawFindings[i], nextId, context);
		if (finding === null) {
			warnings.push(`Judge finding at index ${i} is malformed; skipped`);
			continue;
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
	const handle = await options.registry.ensure({
		owner: options.target.owner,
		repo: options.target.repo,
		sha: options.target.sha,
	});

	const prompt = buildJudgePrompt({ council: options.council });

	const startId = nextIdAfterCouncil(options.council);

	const dispatched = await options.dispatch({
		reviewer: options.judge,
		prompt,
		cwd: handle.path,
		signal: options.signal,
	});

	const parsed = parseJudgeOutput(dispatched.finalAssistantText, {
		runId: options.runId,
		judgeReviewerId: options.judge.id,
		startId,
	});

	return {
		id: options.runId,
		startedAt: new Date().toISOString(),
		judgeReviewerId: options.judge.id,
		selfSignal: parsed.selfSignal,
		consolidatedFindings: parsed.findings,
		warnings: [...dispatched.warnings, ...parsed.warnings],
		...(dispatched.usage ? { usage: dispatched.usage } : {}),
	};
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
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const confidence = r.confidence;
	const rationale = r.rationale;
	if (typeof confidence !== "string") return null;
	if (!VALID_CONFIDENCES.has(confidence as JudgeSelfSignal["confidence"]))
		return null;
	if (typeof rationale !== "string") return null;
	return {
		confidence: confidence as JudgeSelfSignal["confidence"],
		rationale,
	};
}

function toJudgedFinding(
	raw: unknown,
	id: number,
	context: JudgeParseContext,
): Finding | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;

	const location = toLocation(r.location);
	if (location === null) return null;

	const label = r.label;
	if (
		typeof label !== "string" ||
		!VALID_LABELS.has(label as ConventionalLabel)
	) {
		return null;
	}

	const subject = r.subject;
	if (typeof subject !== "string" || subject.trim().length === 0) return null;

	const discussion = r.discussion;
	if (typeof discussion !== "string" || discussion.trim().length === 0)
		return null;

	const decorations = Array.isArray(r.decorations)
		? r.decorations.filter((d): d is string => typeof d === "string")
		: [];

	const severity =
		typeof r.severity === "string" &&
		VALID_SEVERITIES.has(r.severity as FindingSeverity)
			? (r.severity as FindingSeverity)
			: undefined;

	const confidence =
		typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1
			? r.confidence
			: undefined;

	const category: Finding["category"] =
		location.kind === "global" ? "scope" : "file";

	const agreement = toAgreement(r.raisedBy, r.sourceFindingIds);

	return {
		id,
		location,
		label: label as ConventionalLabel,
		decorations,
		subject,
		discussion,
		category,
		severity,
		confidence,
		origin: {
			kind: "judge",
			runId: context.runId,
			judgeReviewerId: context.judgeReviewerId,
		},
		state: "draft",
		...(agreement !== null ? { agreement } : {}),
	};
}

function toAgreement(
	raisedByRaw: unknown,
	sourceIdsRaw: unknown,
): FindingAgreement | null {
	if (!Array.isArray(raisedByRaw)) return null;
	if (!Array.isArray(sourceIdsRaw)) return null;
	const raisedBy = raisedByRaw.filter(
		(r): r is string => typeof r === "string",
	);
	const sourceFindingIds = sourceIdsRaw.filter(
		(n): n is number => typeof n === "number" && Number.isFinite(n),
	);
	if (raisedBy.length === 0 && sourceFindingIds.length === 0) return null;
	return { raisedBy, sourceFindingIds };
}

function toLocation(raw: unknown): FindingLocation | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const kind = r.kind;
	if (kind === "global") return { kind: "global" };
	if (kind === "file") {
		if (typeof r.file !== "string") return null;
		return { kind: "file", file: r.file };
	}
	if (kind === "line") {
		if (typeof r.file !== "string") return null;
		if (typeof r.start !== "number" || typeof r.end !== "number") return null;
		const side = r.side;
		if (side !== "old" && side !== "new" && side !== "both") return null;
		return { kind: "line", file: r.file, start: r.start, end: r.end, side };
	}
	return null;
}
