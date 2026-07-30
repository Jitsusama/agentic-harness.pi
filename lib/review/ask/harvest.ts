/**
 * Turning what a model answered into findings.
 *
 * Two things shape everything here.
 *
 * A model answers in prose with JSON somewhere inside it, however
 * firmly it was asked not to, so the JSON is looked for rather than
 * assumed. Losing a whole council pass to a code fence nobody was
 * told to omit would be absurd.
 *
 * And one bad entry costs one finding, not the batch. Re-running a
 * council is expensive, so nine good findings survive the tenth
 * being malformed, and every drop leaves a warning naming what went
 * wrong. A silent drop is the one outcome worth avoiding: the
 * caller would believe the reviewer had nothing more to say.
 */

import type { Anchor } from "../anchor.js";
import type { DiffSide } from "../diff.js";
import type {
	ConventionalLabel,
	Finding,
	FindingOrigin,
	FindingSeverity,
} from "../finding.js";

/** What came out of one answer. */
export interface Harvest {
	findings: Omit<Finding, "id">[];
	warnings: string[];
}

/** The labels a finding may carry. */
const LABELS: readonly string[] = [
	"praise",
	"nitpick",
	"suggestion",
	"issue",
	"todo",
	"question",
	"thought",
	"chore",
	"note",
];

/**
 * Severities, and the synonyms models reach for.
 *
 * Mapping a synonym costs nothing next to dropping the severity,
 * and nobody reads an output contract carefully enough to be held
 * to three exact words.
 */
const SEVERITIES: Record<string, FindingSeverity> = {
	critical: "critical",
	blocking: "critical",
	required: "critical",
	high: "critical",
	medium: "medium",
	minor: "minor",
	low: "minor",
	"non-blocking": "minor",
	"nice-to-have": "minor",
	info: "minor",
};

/** Harvest findings from one answer, warning about what it dropped. */
export function harvestFindings(
	text: string,
	origin: FindingOrigin,
	witness?: string,
): Harvest {
	const warnings: string[] = [];
	const parsed = findJson(text);
	if (parsed === undefined) {
		return {
			findings: [],
			warnings: [
				"Nothing in this answer parsed as JSON, so no findings could be read from it. The answer should hold an object with a findings array.",
			],
		};
	}

	const held = parsed.findings;
	if (!Array.isArray(held)) {
		return {
			findings: [],
			warnings: [
				"The JSON in this answer carries no findings array, so there was nothing to read. An answer with nothing to say should still say findings: [].",
			],
		};
	}

	const findings: Omit<Finding, "id">[] = [];
	for (const [index, entry] of held.entries()) {
		const one = readFinding(entry, index, origin, witness, warnings);
		if (one !== undefined) findings.push(one);
	}
	return { findings, warnings };
}

/**
 * The JSON object in an answer, wherever it is.
 *
 * Tries the whole answer first, then a fenced block, then the
 * widest brace-delimited span. The widest rather than the first,
 * because a model that discusses its reasoning before answering
 * often writes a smaller object earlier in the prose.
 */
function findJson(text: string): Record<string, unknown> | undefined {
	const whole = parseObject(text);
	if (whole !== undefined) return whole;

	for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
		const fenced = parseObject(match[1] ?? "");
		if (fenced !== undefined) return fenced;
	}

	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first === -1 || last <= first) return undefined;
	return parseObject(text.slice(first, last + 1));
}

/** One JSON object, or nothing. */
function parseObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	try {
		const held: unknown = JSON.parse(trimmed);
		return isRecord(held) ? held : undefined;
	} catch {
		// Not JSON. Every caller here is guessing at where the JSON
		// might be, so failing to find it is the expected outcome
		// rather than an error worth reporting.
		return undefined;
	}
}

/** One finding, or nothing plus a warning saying why. */
function readFinding(
	entry: unknown,
	index: number,
	origin: FindingOrigin,
	witness: string | undefined,
	warnings: string[],
): Omit<Finding, "id"> | undefined {
	const at = `findings[${index}]`;
	if (!isRecord(entry)) {
		warnings.push(`${at} is not an object, so it was dropped.`);
		return undefined;
	}

	const subject = text(entry.subject);
	if (subject === undefined) {
		warnings.push(`${at} has no subject, so it was dropped.`);
		return undefined;
	}

	const label = text(entry.label);
	if (label === undefined || !LABELS.includes(label)) {
		warnings.push(
			`${at} is labelled "${label ?? "nothing"}", which is not one of ${LABELS.join(", ")}, so it was dropped. Guessing a label would put words in the reviewer's mouth.`,
		);
		return undefined;
	}

	const anchor = readAnchor(entry.location, at, witness, warnings);
	if (anchor === undefined) return undefined;

	return {
		anchor,
		label: label as ConventionalLabel,
		subject,
		discussion: text(entry.discussion) ?? "",
		origin,
		...readSeverity(entry.severity, at, warnings),
		...readConfidence(entry.confidence, at, warnings),
	};
}

/** Where the finding points, or nothing plus a warning. */
function readAnchor(
	value: unknown,
	at: string,
	witness: string | undefined,
	warnings: string[],
): Anchor | undefined {
	const stamp = witness === undefined ? {} : { witness };
	if (!isRecord(value)) {
		warnings.push(`${at} names no location, so it was dropped.`);
		return undefined;
	}

	const kind = text(value.kind);
	if (kind === "global") return { subject: "change", ...stamp };

	const path = text(value.file);
	if (kind === "file") {
		if (path === undefined) {
			warnings.push(`${at} is a file finding with no file, so it was dropped.`);
			return undefined;
		}
		return { subject: "file", path, ...stamp };
	}

	if (kind === "line") {
		if (path === undefined) {
			warnings.push(`${at} is a line finding with no file, so it was dropped.`);
			return undefined;
		}
		const start = whole(value.start);
		const end = whole(value.end) ?? start;
		if (start === undefined || end === undefined) {
			warnings.push(`${at} is a line finding with no line, so it was dropped.`);
			return undefined;
		}
		return {
			subject: "line",
			path,
			blob: side(value.side),
			line: Math.max(start, end),
			// A single line is a line, not a range of one: carrying a
			// startLine equal to the line would have every renderer
			// deciding for itself whether to print "12" or "12-12".
			...(start === end ? {} : { startLine: Math.min(start, end) }),
			...stamp,
		};
	}

	warnings.push(
		`${at} has location kind "${kind ?? "none"}", which is not line, file or global, so it was dropped.`,
	);
	return undefined;
}

/** A severity, dropped with a warning when it is not one. */
function readSeverity(
	value: unknown,
	at: string,
	warnings: string[],
): { severity?: FindingSeverity } {
	const given = text(value);
	if (given === undefined) return {};
	const known = SEVERITIES[given.toLowerCase()];
	if (known === undefined) {
		// The severity is a decoration and the observation is the
		// value, so an unreadable one costs the decoration only.
		warnings.push(
			`${at} has severity "${given}", which is not one of critical, medium, minor, so the finding was kept without it.`,
		);
		return {};
	}
	return { severity: known };
}

/** A confidence, dropped with a warning when it is out of range. */
function readConfidence(
	value: unknown,
	at: string,
	warnings: string[],
): { confidence?: number } {
	if (typeof value !== "number" || Number.isNaN(value)) return {};
	if (value < 0 || value > 1) {
		warnings.push(
			`${at} has confidence ${value}, which is outside 0 to 1, so the finding was kept without it.`,
		);
		return {};
	}
	return { confidence: value };
}

/** Which side of the diff, defaulting to the one a diff shows. */
function side(value: unknown): DiffSide {
	return text(value) === "old" ? "old" : "new";
}

/** A non-empty trimmed string, or nothing. */
function text(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** A whole number, or nothing. */
function whole(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value)
		? value
		: undefined;
}

/** A plain object, as against an array or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
