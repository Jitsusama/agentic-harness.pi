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
import {
	ANSWER_WAS_CUT_OFF,
	isRecord,
	readAnswer,
	wireText,
	wireWhole,
} from "./wire.js";

/** What came out of one answer. */
export interface Harvest {
	findings: Omit<Finding, "id">[];
	warnings: string[];
	/**
	 * Whether these findings are what survived a cut-off answer.
	 *
	 * Reported as a fact rather than left in the warnings, because a
	 * caller that replaces the warnings with its own sentence would
	 * otherwise drop the one thing the reader needs to know: that the
	 * absence of a finding here means nothing either way.
	 */
	truncated?: boolean;
}

/**
 * What came out of one entry: a finding when it was readable, and
 * anything worth saying either way.
 *
 * Exported because a stack-wide answer groups its entries by the
 * change each is about, and every entry still has to be read the same
 * way. One place knows a finding's wire shape.
 */
export interface FindingRead {
	finding?: Omit<Finding, "id">;
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
	// An answer that will not parse is usually not a malformed answer.
	// It is a good one that was interrupted, and everything the
	// reviewer completed before that is still in it.
	const { parsed, truncated } = readAnswer(text, "findings");
	if (parsed === undefined) {
		return {
			findings: [],
			truncated: false,
			warnings: [
				"Nothing in this answer parsed as JSON, so no findings could be read from it. The answer should hold an object with a findings array.",
			],
		};
	}
	if (truncated) warnings.push(ANSWER_WAS_CUT_OFF);

	const held = parsed.findings;
	if (!Array.isArray(held)) {
		return {
			findings: [],
			truncated: false,
			warnings: [
				"The JSON in this answer carries no findings array, so there was nothing to read. An answer with nothing to say should still say findings: [].",
			],
		};
	}

	const findings: Omit<Finding, "id">[] = [];
	for (const [index, entry] of held.entries()) {
		const read = readWireFinding(entry, `findings[${index}]`, origin, witness);
		warnings.push(...read.warnings);
		if (read.finding !== undefined) findings.push(read.finding);
	}
	return { findings, warnings, truncated };
}

/**
 * Read one entry off the wire.
 *
 * `at` is how the entry is named in a warning, and the caller supplies
 * it because only the caller knows what the entry was found inside.
 */
export function readWireFinding(
	entry: unknown,
	at: string,
	origin: FindingOrigin,
	witness?: string,
): FindingRead {
	const warnings: string[] = [];
	const finding = readFinding(entry, at, origin, witness, warnings);
	return { ...(finding === undefined ? {} : { finding }), warnings };
}

/** One finding, or nothing plus a warning saying why. */
function readFinding(
	entry: unknown,
	at: string,
	origin: FindingOrigin,
	witness: string | undefined,
	warnings: string[],
): Omit<Finding, "id"> | undefined {
	if (!isRecord(entry)) {
		warnings.push(`${at} is not an object, so it was dropped.`);
		return undefined;
	}

	const subject = wireText(entry.subject);
	if (subject === undefined) {
		warnings.push(`${at} has no subject, so it was dropped.`);
		return undefined;
	}

	const label = wireText(entry.label);
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
		discussion: wireText(entry.discussion) ?? "",
		origin,
		...readSeverity(entry.severity, at, warnings),
		...readConfidence(entry.confidence, at, warnings),
		...readRaisedBy(entry.raisedBy, at, warnings),
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

	const kind = wireText(value.kind);
	if (kind === "global") return { subject: "change", ...stamp };

	const path = wireText(value.file);
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
		const start = wireWhole(value.start);
		const end = wireWhole(value.end) ?? start;
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

/**
 * Who else raised this, when a consolidating pass says.
 *
 * Agreement between independent reviewers is evidence, and a
 * consolidating pass is the only one that knows about it, so losing
 * it here would throw away the reason a finding is more likely to be
 * real. Blank names are dropped rather than held, since an empty id
 * matches nobody and would make an attribution check answer wrongly.
 */
function readRaisedBy(
	value: unknown,
	at: string,
	warnings: string[],
): { raisedBy?: string[] } {
	if (value === undefined) return {};
	if (!Array.isArray(value)) {
		warnings.push(
			`${at} has raisedBy that is not a list of participant ids, so the finding was kept without its agreement.`,
		);
		return {};
	}
	const raisedBy = value.flatMap((entry) => {
		const name = wireText(entry);
		return name === undefined ? [] : [name];
	});
	return raisedBy.length === 0 ? {} : { raisedBy };
}

/** A severity, dropped with a warning when it is not one. */
function readSeverity(
	value: unknown,
	at: string,
	warnings: string[],
): { severity?: FindingSeverity } {
	const given = wireText(value);
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
	return wireText(value) === "old" ? "old" : "new";
}
