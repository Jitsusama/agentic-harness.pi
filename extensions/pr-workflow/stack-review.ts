/**
 * Stack-wide review prompt and parser primitives.
 *
 * Phase B changes the review shape from "run the same
 * single-PR council N times" to "review the stack as a
 * sequence of PRs, preserving per-PR findings and adding
 * first-class cross-PR findings".
 *
 * This module is deliberately pure. It does not spawn pi,
 * provision worktrees or mutate workflow state. It gives
 * the next action-wiring slice stable prompt builders and
 * parsers to call.
 */

import { Value } from "@sinclair/typebox/value";
import type { DiffFile, DiffLine } from "../../lib/internal/github/diff.js";
import type { Finding, FindingLocation } from "./findings.js";
import {
	CouncilFinding,
	type CouncilFinding as CouncilFindingType,
	JudgeFinding,
	type JudgeFinding as JudgeFindingType,
	JudgeSelfSignal,
	type JudgeSelfSignal as JudgeSelfSignalType,
	StackCriticFinding,
	type StackCriticFinding as StackCriticFindingType,
	StackJudgeCrossFinding,
	type StackJudgeCrossFinding as StackJudgeCrossFindingType,
	StackJudgeOutput,
	StackReviewOutput,
} from "./schemas.js";
import type { StackFinding } from "./stack-critic.js";

/** One PR's full stack-review input. */
export interface StackReviewPrInput {
	readonly prNumber: number;
	readonly title: string;
	readonly description: string;
	readonly files: readonly DiffFile[];
}

/** Inputs to `buildStackReviewPrompt`. */
export interface BuildStackReviewPromptInput {
	readonly cursorPrNumber: number;
	readonly prs: readonly StackReviewPrInput[];
}

/** One reviewer's parsed stack-wide output. */
export interface StackReviewerOutput {
	readonly reviewerId: string;
	readonly perPr: Map<number, Finding[]>;
	readonly crossPr: StackFinding[];
	readonly warnings: string[];
}

/** Caller-supplied context for stack-review parsing. */
export interface StackReviewParseContext {
	readonly runId: string;
	readonly reviewerId: string;
	readonly startId: number;
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
}

/** Inputs to `buildStackJudgePrompt`. */
export interface BuildStackJudgePromptInput {
	readonly cursorPrNumber: number;
	readonly prs: readonly StackJudgePrContext[];
	readonly reviewerOutputs: readonly StackReviewerOutput[];
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
	sections.push("## Stack");
	for (const pr of input.prs) {
		sections.push(renderPrForReview(pr, input.cursorPrNumber));
	}
	sections.push("## Output format");
	sections.push(
		"Reply with a fenced JSON block. No prose outside the block. The JSON " +
			"object must have `perPr` and `crossPr`. `perPr` is an object keyed " +
			"by PR number as a string. Include every PR key, using an empty array " +
			"when that PR has no findings. `crossPr` is an array of findings " +
			"with `homePrNumber` and non-empty `spans`.",
	);
	sections.push("## JSON Schema");
	sections.push(
		"Your output must match this JSON Schema exactly. The same schema is " +
			"used by the `verify_output` tool you'll call below and by the parent " +
			"parser, so anything that passes the verifier will be accepted.",
	);
	sections.push(
		["```json", JSON.stringify(StackReviewOutput, null, 2), "```"].join("\n"),
	);
	sections.push("## Self-verify before ending");
	sections.push(
		"Before you finish your run, call the `verify_output` tool with " +
			'stage: "stack-review" and `output` set to the object you intend ' +
			"to emit. Fix any reported errors, verify again, then emit the final " +
			"fenced JSON block.",
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
	sections.push("## Stack PRs");
	for (const pr of input.prs) {
		const cursor = pr.prNumber === input.cursorPrNumber ? " [cursor]" : "";
		sections.push(`- PR #${pr.prNumber}${cursor}: ${pr.title}`);
	}
	sections.push("## Reviewer findings");
	for (const output of input.reviewerOutputs) {
		sections.push(renderReviewerForJudge(output));
	}
	sections.push("## JSON Schema");
	sections.push(
		"Your output must match this JSON Schema exactly. The same schema is " +
			"used by the `verify_output` tool you'll call below and by the parent " +
			"parser, so anything that passes the verifier will be accepted.",
	);
	sections.push(
		["```json", JSON.stringify(StackJudgeOutput, null, 2), "```"].join("\n"),
	);
	sections.push("## Self-verify before ending");
	sections.push(
		"Before you finish your run, call the `verify_output` tool with " +
			'stage: "stack-judge" and `output` set to the object you intend ' +
			"to emit. Fix any reported errors, verify again, then emit the final " +
			"fenced JSON block.",
	);
	return sections.join("\n\n");
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
	const record = parsed.value as Record<string, unknown>;
	const warnings: string[] = [];
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
	const record = parsed.value as Record<string, unknown>;
	const selfSignal = Value.Check(JudgeSelfSignal, record.selfSignal)
		? record.selfSignal
		: null;
	const warnings: string[] = [];
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
			parsed.push(toCouncilFinding(rawFinding, ids.next, context));
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
		if (!Value.Check(StackCriticFinding, rawFinding)) {
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
		origin: {
			kind: "stack-review",
			runId: context.runId,
			reviewerId: context.reviewerId,
		},
		state: "draft",
	};
}

function toStackReviewFinding(
	raw: StackCriticFindingType,
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
	return `  [id=${finding.id}] [${finding.label}] ${finding.subject} ${renderLocation(finding.location)}\n    ${finding.discussion}`;
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

function extractJson(text: string): string | null {
	const fenced = text.match(/```json\s*\n([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();
	const objectStart = text.indexOf("{");
	if (objectStart === -1) return null;
	return text.slice(objectStart);
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
