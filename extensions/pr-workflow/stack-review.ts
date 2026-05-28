/**
 * Stack-wide review prompt and parser primitives.
 *
 * Reviewers see the stack as a sequence of PRs, preserving
 * per-PR findings while adding first-class cross-PR
 * findings.
 *
 * This module is deliberately pure. It does not spawn pi,
 * provision worktrees or mutate workflow state.
 */

import { Value } from "@sinclair/typebox/value";
import type { DiffFile, DiffLine } from "../../lib/internal/github/diff.js";
import type { ReviewerVerification } from "../../lib/subagent/subagent.js";
import type { Finding, FindingLocation } from "./findings.js";
import { extractJson } from "./parse.js";
import { hasValidInlineAnchor } from "./post.js";
import { reviewerOperatingRules } from "./prompt-operating-rules.js";
import {
	reviewQualityStandard,
	stackReviewDiscoveryStandard,
	stackReviewSynthesisStandard,
} from "./review-quality-standard.js";
import {
	CouncilFinding,
	type CouncilFinding as CouncilFindingType,
	JudgeFinding,
	type JudgeFinding as JudgeFindingType,
	JudgeSelfSignal,
	type JudgeSelfSignal as JudgeSelfSignalType,
	StackCrossFinding,
	type StackCrossFinding as StackCrossFindingType,
	StackJudgeCrossFinding,
	type StackJudgeCrossFinding as StackJudgeCrossFindingType,
} from "./schemas.js";
import { normalizeFindingSeverities } from "./severity-normalize.js";
import type { StackFinding } from "./stack-findings.js";
import {
	type ReviewThreadPromptContext,
	renderReviewThreadPromptContext,
	renderThreadRelation,
} from "./thread-context.js";

/** One PR's full stack-review input. */
export interface StackReviewPrInput {
	readonly prNumber: number;
	readonly title: string;
	readonly description: string;
	readonly files: readonly DiffFile[];
	readonly threadContext?: ReviewThreadPromptContext;
}

/** Inputs to `buildStackReviewPrompt`. */
export interface BuildStackReviewPromptInput {
	readonly cursorPrNumber: number;
	readonly prs: readonly StackReviewPrInput[];
	readonly promptAddendum?: string;
}

/** One reviewer's parsed stack-wide output. */
export interface StackReviewerOutput {
	readonly reviewerId: string;
	readonly perPr: Map<number, Finding[]>;
	readonly crossPr: StackFinding[];
	readonly warnings: string[];
	/** Result of this reviewer's verify_output calls, when observed. */
	readonly verification?: ReviewerVerification;
}

/** Caller-supplied context for stack-review parsing. */
export interface StackReviewParseContext {
	readonly runId: string;
	readonly reviewerId: string;
	readonly startId: number;
	/**
	 * Loaded diffs per PR number, keyed for anchor
	 * validation. When supplied, line-kind findings in
	 * `perPr[N]` whose anchor doesn't match the diff for
	 * PR N emit a warning. Omit to skip the check.
	 */
	readonly diffsByPr?: ReadonlyMap<number, readonly DiffFile[]>;
}

/** Result of `parseStackReviewOutput`. */
export interface StackReviewParseResult {
	readonly perPr: Map<number, Finding[]>;
	readonly crossPr: StackFinding[];
	readonly warnings: string[];
}

/** One PR's judge prompt context. */
export interface StackJudgePrContext {
	readonly prNumber: number;
	readonly title: string;
	readonly threadContext?: ReviewThreadPromptContext;
}

/** Inputs to `buildStackJudgePrompt`. */
export interface BuildStackJudgePromptInput {
	readonly cursorPrNumber: number;
	readonly prs: readonly StackJudgePrContext[];
	readonly reviewerOutputs: readonly StackReviewerOutput[];
	readonly promptAddendum?: string;
}

/** Caller-supplied context for stack-judge parsing. */
export interface StackJudgeParseContext {
	readonly runId: string;
	readonly judgeReviewerId: string;
	readonly startId: number;
}

/** Result of `parseStackJudgeOutput`. */
export interface StackJudgeParseResult {
	readonly selfSignal: JudgeSelfSignalType | null;
	readonly perPr: Map<number, Finding[]>;
	readonly crossPr: StackFinding[];
	readonly warnings: string[];
}

/** Build the stack-wide reviewer prompt. */
export function buildStackReviewPrompt(
	input: BuildStackReviewPromptInput,
): string {
	const sections: string[] = [];
	sections.push(
		"You are a senior code reviewer participating in a multi-model " +
			"stack-wide code review council. The user is reviewing a stack of " +
			"pull requests that build on each other. Review each PR deeply in " +
			"order, then report cross-PR findings that only become visible " +
			"when the stack is read together.",
	);
	sections.push(
		"Discipline: walk each PR in order. Before moving to the next PR, " +
			"decide every finding that belongs to the current PR and place it " +
			'under `perPr["<number>"]`. After the last PR, add only true ' +
			"cross-PR observations under `crossPr`.",
	);
	sections.push(
		`The cursor is PR #${input.cursorPrNumber}. Cross-PR findings need ` +
			"`homePrNumber` for the posting destination and `spans` listing " +
			"every PR the finding refers to.",
	);
	sections.push(reviewQualityStandard());
	sections.push(stackReviewDiscoveryStandard());
	pushPromptAddendum(sections, input.promptAddendum);
	sections.push(reviewerOperatingRules());
	sections.push("## Stack");
	for (const pr of input.prs) {
		sections.push(renderPrForReview(pr, input.cursorPrNumber));
	}
	sections.push("## Output format");
	sections.push(
		"Follow the `pr-workflow-stack-review-output` skill for your output " +
			"contract: the JSON shape (`perPr` per-PR keys plus `crossPr` with " +
			"`homePrNumber`/`spans`), discipline rules and the `verify_output` " +
			"self-check protocol. The skill is loaded into this subagent. Rely on " +
			"`verify_output`'s feedback to converge on a valid payload before " +
			"ending your run.",
	);
	return sections.join("\n\n");
}

/** Build the stack-wide judge prompt. */
export function buildStackJudgePrompt(
	input: BuildStackJudgePromptInput,
): string {
	const sections: string[] = [];
	sections.push(
		"You are the judge for a stack-wide multi-reviewer council. You receive " +
			"reviewer findings split by PR plus cross-PR findings. Consolidate " +
			"per-PR findings independently, then consolidate cross-PR findings.",
	);
	sections.push(
		"Synthesize, do not concatenate. Similar findings from multiple " +
			"reviewers become one consolidated finding with `raisedBy` and " +
			"`sourceFindingIds`. Keep PR membership intact: a finding under " +
			'PR #101 must stay under `perPr["101"]` unless it truly spans ' +
			"multiple PRs, in which case it belongs in `crossPr`.",
	);
	sections.push(`The cursor is PR #${input.cursorPrNumber}.`);
	sections.push(reviewQualityStandard());
	sections.push(stackReviewSynthesisStandard());
	pushPromptAddendum(sections, input.promptAddendum);
	sections.push(reviewerOperatingRules());
	sections.push("## Stack PRs");
	for (const pr of input.prs) {
		const cursor = pr.prNumber === input.cursorPrNumber ? " [cursor]" : "";
		sections.push(`- PR #${pr.prNumber}${cursor}: ${pr.title}`);
		if (pr.threadContext !== undefined) {
			sections.push(renderReviewThreadPromptContext(pr.threadContext));
		}
	}
	sections.push("## Reviewer findings");
	for (const output of input.reviewerOutputs) {
		sections.push(renderReviewerForJudge(output));
	}
	sections.push("## Output format");
	sections.push(
		"Follow the `pr-workflow-stack-judge-output` skill for your output " +
			"contract: the JSON shape (optional `selfSignal` plus `perPr`/`crossPr` " +
			"with attribution fields), the membership rule and the " +
			"`verify_output` self-check protocol. The skill is loaded into this " +
			"subagent. Rely on `verify_output`'s feedback to converge on a valid " +
			"payload before ending your run.",
	);
	return sections.join("\n\n");
}

function pushPromptAddendum(
	sections: string[],
	addendum: string | undefined,
): void {
	const trimmed = addendum?.trim();
	if (trimmed === undefined || trimmed.length === 0) return;
	sections.push(["## Provider review context", trimmed].join("\n\n"));
}

/** Parse one stack-wide reviewer response. */
export function parseStackReviewOutput(
	text: string,
	context: StackReviewParseContext,
): StackReviewParseResult {
	const jsonText = extractJson(text);
	if (jsonText === null) {
		return emptyReviewParse([
			"Stack reviewer response contained no JSON block",
		]);
	}
	const parsed = parseJson(jsonText, "Stack reviewer");
	if (!parsed.ok) return emptyReviewParse([parsed.warning]);
	if (typeof parsed.value !== "object" || parsed.value === null) {
		return emptyReviewParse([
			"Stack reviewer JSON top-level was not an object",
		]);
	}
	const severityNormalization = normalizeFindingSeverities(parsed.value);
	const record = severityNormalization.value as Record<string, unknown>;
	const warnings: string[] = [...severityNormalization.warnings];
	const ids = { next: context.startId };
	const perPr = parsePerPrCouncil(record.perPr, context, warnings, ids);
	const crossPr = parseCrossPrReview(record.crossPr, context, warnings, ids);
	return { perPr, crossPr, warnings };
}

/** Parse one stack-wide judge response. */
export function parseStackJudgeOutput(
	text: string,
	context: StackJudgeParseContext,
): StackJudgeParseResult {
	const jsonText = extractJson(text);
	if (jsonText === null) {
		return emptyJudgeParse(["Stack judge response contained no JSON block"]);
	}
	const parsed = parseJson(jsonText, "Stack judge");
	if (!parsed.ok) return emptyJudgeParse([parsed.warning]);
	if (typeof parsed.value !== "object" || parsed.value === null) {
		return emptyJudgeParse(["Stack judge JSON top-level was not an object"]);
	}
	const severityNormalization = normalizeFindingSeverities(parsed.value);
	const record = severityNormalization.value as Record<string, unknown>;
	const selfSignal = Value.Check(JudgeSelfSignal, record.selfSignal)
		? record.selfSignal
		: null;
	const warnings: string[] = [...severityNormalization.warnings];
	const ids = { next: context.startId };
	const perPr = parsePerPrJudge(record.perPr, context, warnings, ids);
	const crossPr = parseCrossPrJudge(record.crossPr, context, warnings, ids);
	return { selfSignal, perPr, crossPr, warnings };
}

function parsePerPrCouncil(
	raw: unknown,
	context: StackReviewParseContext,
	warnings: string[],
	ids: { next: number },
): Map<number, Finding[]> {
	const out = new Map<number, Finding[]>();
	if (!isRecord(raw)) {
		warnings.push("Stack reviewer JSON did not contain a perPr object");
		return out;
	}
	for (const [key, findings] of Object.entries(raw)) {
		const prNumber = parsePrKey(key, warnings);
		if (prNumber === null) continue;
		if (!Array.isArray(findings)) {
			warnings.push(`perPr[${key}] was not an array; skipped`);
			continue;
		}
		const diffFiles = context.diffsByPr?.get(prNumber);
		const parsed: Finding[] = [];
		for (let i = 0; i < findings.length; i++) {
			const rawFinding = findings[i];
			if (!Value.Check(CouncilFinding, rawFinding)) {
				warnings.push(
					`perPr[${key}] finding at index ${i} is malformed; skipped`,
				);
				continue;
			}
			if (
				rawFinding.subject.trim() === "" ||
				rawFinding.discussion.trim() === ""
			) {
				warnings.push(
					`perPr[${key}] finding at index ${i} is malformed; skipped`,
				);
				continue;
			}
			const finding = toCouncilFinding(rawFinding, ids.next, context);
			if (diffFiles && diffFiles.length > 0) {
				const anchorWarning = stackLineAnchorWarning(
					prNumber,
					finding,
					diffFiles,
				);
				if (anchorWarning) warnings.push(anchorWarning);
			}
			parsed.push(finding);
			ids.next++;
		}
		out.set(prNumber, parsed);
	}
	return out;
}

function parseCrossPrReview(
	raw: unknown,
	context: StackReviewParseContext,
	warnings: string[],
	ids: { next: number },
): StackFinding[] {
	if (!Array.isArray(raw)) {
		warnings.push("Stack reviewer JSON did not contain a crossPr array");
		return [];
	}
	const out: StackFinding[] = [];
	for (let i = 0; i < raw.length; i++) {
		const rawFinding = raw[i];
		if (!Value.Check(StackCrossFinding, rawFinding)) {
			warnings.push(`crossPr finding at index ${i} is malformed; skipped`);
			continue;
		}
		out.push(toStackReviewFinding(rawFinding, ids.next, context));
		ids.next++;
	}
	return out;
}

function parsePerPrJudge(
	raw: unknown,
	context: StackJudgeParseContext,
	warnings: string[],
	ids: { next: number },
): Map<number, Finding[]> {
	const out = new Map<number, Finding[]>();
	if (!isRecord(raw)) {
		warnings.push("Stack judge JSON did not contain a perPr object");
		return out;
	}
	for (const [key, findings] of Object.entries(raw)) {
		const prNumber = parsePrKey(key, warnings);
		if (prNumber === null) continue;
		if (!Array.isArray(findings)) {
			warnings.push(`perPr[${key}] was not an array; skipped`);
			continue;
		}
		const parsed: Finding[] = [];
		for (let i = 0; i < findings.length; i++) {
			const rawFinding = findings[i];
			if (!Value.Check(JudgeFinding, rawFinding)) {
				warnings.push(
					`perPr[${key}] judge finding at index ${i} is malformed; skipped`,
				);
				continue;
			}
			if (
				rawFinding.subject.trim() === "" ||
				rawFinding.discussion.trim() === ""
			) {
				warnings.push(
					`perPr[${key}] judge finding at index ${i} is malformed; skipped`,
				);
				continue;
			}
			parsed.push(toJudgeFinding(rawFinding, ids.next, context));
			ids.next++;
		}
		out.set(prNumber, parsed);
	}
	return out;
}

function parseCrossPrJudge(
	raw: unknown,
	context: StackJudgeParseContext,
	warnings: string[],
	ids: { next: number },
): StackFinding[] {
	if (!Array.isArray(raw)) {
		warnings.push("Stack judge JSON did not contain a crossPr array");
		return [];
	}
	const out: StackFinding[] = [];
	for (let i = 0; i < raw.length; i++) {
		const rawFinding = raw[i];
		if (!Value.Check(StackJudgeCrossFinding, rawFinding)) {
			warnings.push(
				`crossPr judge finding at index ${i} is malformed; skipped`,
			);
			continue;
		}
		out.push(toStackJudgeFinding(rawFinding, ids.next, context));
		ids.next++;
	}
	return out;
}

function toCouncilFinding(
	raw: CouncilFindingType,
	id: number,
	context: StackReviewParseContext,
): Finding {
	return {
		id,
		location: raw.location,
		label: raw.label,
		decorations: raw.decorations ?? [],
		subject: raw.subject,
		discussion: raw.discussion,
		category: categoryFor(raw.location),
		severity: raw.severity,
		confidence: raw.confidence,
		threadRelation: raw.threadRelation,
		origin: {
			kind: "stack-review",
			runId: context.runId,
			reviewerId: context.reviewerId,
		},
		state: "draft",
	};
}

function toStackReviewFinding(
	raw: StackCrossFindingType,
	id: number,
	context: StackReviewParseContext,
): StackFinding {
	return {
		...toCouncilFinding(raw, id, context),
		origin: {
			kind: "stack-review",
			runId: context.runId,
			reviewerId: context.reviewerId,
		},
		homePrNumber: raw.homePrNumber,
		spans: raw.spans,
	};
}

function toJudgeFinding(
	raw: JudgeFindingType,
	id: number,
	context: StackJudgeParseContext,
): Finding {
	const agreement = liftAgreement(raw.raisedBy, raw.sourceFindingIds);
	return {
		id,
		location: raw.location,
		label: raw.label,
		decorations: raw.decorations ?? [],
		subject: raw.subject,
		discussion: raw.discussion,
		category: categoryFor(raw.location),
		severity: raw.severity,
		confidence: raw.confidence,
		threadRelation: raw.threadRelation,
		origin: {
			kind: "stack-judge",
			runId: context.runId,
			judgeReviewerId: context.judgeReviewerId,
		},
		state: "draft",
		...(agreement !== null ? { agreement } : {}),
	};
}

function toStackJudgeFinding(
	raw: StackJudgeCrossFindingType,
	id: number,
	context: StackJudgeParseContext,
): StackFinding {
	const agreement = liftAgreement(raw.raisedBy, raw.sourceFindingIds);
	return {
		id,
		location: raw.location,
		label: raw.label,
		decorations: raw.decorations ?? [],
		subject: raw.subject,
		discussion: raw.discussion,
		category: categoryFor(raw.location),
		severity: raw.severity,
		confidence: raw.confidence,
		threadRelation: raw.threadRelation,
		origin: {
			kind: "stack-judge",
			runId: context.runId,
			judgeReviewerId: context.judgeReviewerId,
		},
		state: "draft",
		...(agreement !== null ? { agreement } : {}),
		homePrNumber: raw.homePrNumber,
		spans: raw.spans,
	};
}

function renderPrForReview(
	pr: StackReviewPrInput,
	cursorPrNumber: number,
): string {
	const sections: string[] = [];
	const cursor = pr.prNumber === cursorPrNumber ? " [cursor]" : "";
	sections.push(`### PR #${pr.prNumber}${cursor}: ${pr.title || "(no title)"}`);
	if (pr.description.trim() !== "") {
		sections.push("#### PR description");
		sections.push(pr.description.trim());
	}
	if (pr.threadContext !== undefined) {
		sections.push(renderReviewThreadPromptContext(pr.threadContext));
	}
	sections.push("#### Diff");
	if (pr.files.length === 0) {
		sections.push("(no files changed)");
	} else {
		for (const file of pr.files) sections.push(renderFile(file));
	}
	return sections.join("\n\n");
}

function renderReviewerForJudge(output: StackReviewerOutput): string {
	const sections: string[] = [];
	sections.push(`### Reviewer ${output.reviewerId}`);
	for (const [prNumber, findings] of [...output.perPr.entries()].sort(
		([a], [b]) => a - b,
	)) {
		sections.push(`PR #${prNumber}:`);
		if (findings.length === 0) {
			sections.push("  (no findings)");
			continue;
		}
		for (const finding of findings)
			sections.push(renderFindingForPrompt(finding));
	}
	sections.push("Cross-PR:");
	if (output.crossPr.length === 0) {
		sections.push("  (no cross-PR findings)");
	} else {
		for (const finding of output.crossPr)
			sections.push(renderStackFindingForPrompt(finding));
	}
	return sections.join("\n");
}

function renderFindingForPrompt(finding: Finding): string {
	const relation = renderThreadRelation(finding.threadRelation);
	const thread = relation === null ? "" : `\n    thread: ${relation}`;
	return `  [id=${finding.id}] [${finding.label}] ${finding.subject} ${renderLocation(finding.location)}\n    ${finding.discussion}${thread}`;
}

function renderStackFindingForPrompt(finding: StackFinding): string {
	return `${renderFindingForPrompt(finding)}\n    homePrNumber=${finding.homePrNumber}; spans=${finding.spans.join(", ")}`;
}

function renderFile(file: DiffFile): string {
	const header = `##### ${file.path} (${file.status})`;
	if (file.hunks.length === 0) return `${header}\n(no hunks)`;
	return `${header}\n${file.hunks
		.map((h) => `${h.header}\n${h.lines.map(renderLine).join("\n")}`)
		.join("\n")}`;
}

function renderLine(line: DiffLine): string {
	switch (line.type) {
		case "added":
			return `+${line.content}`;
		case "removed":
			return `-${line.content}`;
		default:
			return ` ${line.content}`;
	}
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

function categoryFor(loc: FindingLocation): Finding["category"] {
	return loc.kind === "global" ? "scope" : "file";
}

function liftAgreement(
	raisedBy: readonly string[] | undefined,
	sourceFindingIds: readonly number[] | undefined,
): { raisedBy: string[]; sourceFindingIds: number[] } | null {
	const rb = raisedBy ?? [];
	const sids = sourceFindingIds ?? [];
	if (rb.length === 0 && sids.length === 0) return null;
	return { raisedBy: [...rb], sourceFindingIds: [...sids] };
}

function parseJson(
	jsonText: string,
	label: string,
): { ok: true; value: unknown } | { ok: false; warning: string } {
	try {
		return { ok: true, value: JSON.parse(jsonText) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, warning: `${label} JSON failed to parse: ${message}` };
	}
}

/**
 * Mirror of `parse.ts`'s anchor warning for stack-review
 * per-PR findings. Routes the warning through the
 * stack-review warnings list so the user sees it in the
 * stack-review summary instead of having to dig through
 * state.
 */
function stackLineAnchorWarning(
	prNumber: number,
	finding: Finding,
	diffFiles: readonly DiffFile[],
): string | null {
	if (finding.location.kind !== "line") return null;
	if (hasValidInlineAnchor(finding.location, diffFiles)) return null;
	const { file, start, end } = finding.location;
	return (
		`PR #${prNumber} finding ${finding.id} anchors at ${file}:${start}-${end} ` +
		"but those lines are not in the PR diff hunks; it will degrade to a " +
		"body comment. Use `verdict=edit` with the correct line range to fix."
	);
}

function parsePrKey(key: string, warnings: string[]): number | null {
	if (!/^[1-9][0-9]*$/.test(key)) {
		warnings.push(`perPr key "${key}" is not a PR number; skipped`);
		return null;
	}
	return Number.parseInt(key, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyReviewParse(warnings: string[]): StackReviewParseResult {
	return { perPr: new Map(), crossPr: [], warnings };
}

function emptyJudgeParse(warnings: string[]): StackJudgeParseResult {
	return { selfSignal: null, perPr: new Map(), crossPr: [], warnings };
}
