/**
 * Reviewer response parser.
 *
 * Real-world LLM output is messy. The parser extracts the
 * first plausible JSON block from a response, validates
 * each finding entry against the expected shape, and
 * returns the typed findings plus a list of warnings for
 * the caller to surface. One bad entry doesn't abort the
 * batch; we keep the good ones.
 *
 * The parser is pure and synchronous. It owns id assignment
 * (sequential from `startId`) and origin stamping so callers
 * don't have to.
 */

import type {
	ConventionalLabel,
	Finding,
	FindingLocation,
	FindingSeverity,
} from "./findings.js";

/** Caller-supplied context for parsing. */
export interface ParseContext {
	/** Reviewer that produced this output. */
	readonly reviewerId: string;
	/** Council run this output belongs to. */
	readonly runId: string;
	/** Id to assign the first finding; subsequent get startId + 1, ... */
	readonly startId: number;
}

/** Parse result: typed findings plus parse warnings. */
export interface ParseResult {
	readonly findings: Finding[];
	readonly warnings: string[];
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

/**
 * Parse a reviewer's response into structured findings.
 * Warnings carry context for the caller to surface but
 * don't abort parsing.
 */
export function parseReviewerOutput(
	text: string,
	context: ParseContext,
): ParseResult {
	const jsonText = extractJson(text);
	if (jsonText === null) {
		return {
			findings: [],
			warnings: ["Reviewer response contained no JSON block"],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			findings: [],
			warnings: [`Reviewer JSON failed to parse: ${message}`],
		};
	}

	const rawFindings = extractFindingsArray(parsed);
	if (rawFindings === null) {
		return {
			findings: [],
			warnings: [
				'Reviewer JSON did not contain a "findings" array at the top level',
			],
		};
	}

	const findings: Finding[] = [];
	const warnings: string[] = [];
	let nextId = context.startId;

	for (let i = 0; i < rawFindings.length; i++) {
		const finding = toFinding(rawFindings[i], nextId, context);
		if (finding === null) {
			warnings.push(`Finding at index ${i} is malformed; skipped`);
			continue;
		}
		findings.push(finding);
		nextId++;
	}

	return { findings, warnings };
}

function extractJson(text: string): string | null {
	// Prefer fenced ```json blocks since they're the
	// instructed format. Fall back to the first balanced
	// object so plain JSON responses still parse.
	const fenced = text.match(/```json\s*\n([\s\S]*?)```/);
	if (fenced) {
		return fenced[1].trim();
	}
	const objectStart = text.indexOf("{");
	if (objectStart === -1) return null;
	return text.slice(objectStart);
}

function extractFindingsArray(parsed: unknown): unknown[] | null {
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (!Array.isArray(record.findings)) return null;
	return record.findings;
}

function toFinding(
	raw: unknown,
	id: number,
	context: ParseContext,
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
			kind: "council",
			runId: context.runId,
			reviewerId: context.reviewerId,
		},
		state: "draft",
	};
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
		return {
			kind: "line",
			file: r.file,
			start: r.start,
			end: r.end,
			side,
		};
	}
	return null;
}
