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

import { type Anchor, anchorPath } from "../anchor.js";
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

/**
 * Said of a reviewer that produced no answer at all.
 *
 * Its own sentence, because "this did not parse" is a complaint about
 * an answer and there was none. Withdrawn when the reviewer turns out
 * to have recorded findings as it went, which is the case this whole
 * mechanism exists for.
 */
export const SAID_NOTHING =
	"This reviewer produced no answer at all, so there was nothing to read.";

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
	/**
	 * Of the warnings above, the ones about entries the reviewer
	 * recorded rather than about the shape of its answer.
	 *
	 * Named rather than left to be worked out by position, because
	 * the caller that needs them is the one that replaces the whole
	 * list, and reconstructing them by slicing assumes this function
	 * only ever appends. It does not: it withdraws a warning when the
	 * recorded entries turn out to answer it.
	 */
	recordedWarnings?: string[];
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
			// A reviewer that never got as far as answering has not
			// broken a contract about the shape of an answer, and saying
			// it did sends the reader to fix the wrong thing. It is still
			// worth reporting, so it gets its own sentence, which
			// alsoRecorded takes back if it turns out the reviewer had
			// been writing findings down all along.
			warnings: [
				text.trim() === ""
					? SAID_NOTHING
					: "Nothing in this answer parsed as JSON, so no findings could be read from it. The answer should hold an object with a findings array.",
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
 * The answer, plus anything the reviewer wrote down on its way to it.
 *
 * A reviewer records a finding when it finds one and then repeats it in
 * its answer, which is what it is asked to do, so most of these arrive
 * twice. Reporting both would inflate every round and leave the judge
 * consolidating a finding against itself.
 *
 * Where a finding was said twice the answer's telling wins, since it
 * was written after the investigation rather than during it, and the
 * recorded copy is kept only when the answer never got that far. That
 * is the whole point: what was written down does not depend on the
 * reviewer living long enough to say it again.
 */
export function alsoRecorded(
	said: Harvest,
	recorded: readonly unknown[] | undefined,
	origin: FindingOrigin,
	witness?: string,
): Harvest {
	if (recorded === undefined || recorded.length === 0) return said;
	const findings = [...said.findings];
	const recordedWarnings: string[] = [];
	const before = findings.length;
	for (const [index, entry] of recorded.entries()) {
		const read = readWireFinding(entry, `recorded[${index}]`, origin, witness);
		recordedWarnings.push(...read.warnings);
		const found = read.finding;
		if (found === undefined) continue;
		// Scanned rather than keyed, because a finding that named no
		// file has to match one that did, and a hash cannot express
		// that. The lists are tens of entries long.
		if (findings.some((held) => saysTheSame(held, found))) continue;
		findings.push(found);
	}
	// It said nothing at the end, but it had been saying things all
	// along, and that is the arrangement working rather than a fault.
	const aboutTheAnswer =
		findings.length > before
			? said.warnings.filter((warning) => warning !== SAID_NOTHING)
			: said.warnings;
	return {
		...said,
		findings,
		warnings: [...aboutTheAnswer, ...recordedWarnings],
		recordedWarnings,
	};
}

/** The subject, folded to survive a reviewer tidying its punctuation. */
function foldedSubject(finding: Omit<Finding, "id">): string {
	// Folded before the ends are trimmed, or a subject recorded with a
	// full stop and repeated without one reads as two findings, which
	// is the likeliest way of all to say one thing twice.
	return finding.subject
		.toLowerCase()
		.replace(/[\s.,;:]+/g, " ")
		.trim();
}

/** The file it points at, or nothing when it points at the change. */
function pathOf(finding: Omit<Finding, "id">): string {
	const at = finding.anchor;
	return at === undefined ? "" : (anchorPath(at) ?? "");
}

/**
 * Whether two findings say the same finding, allowing for one of them
 * not having said where.
 *
 * Subject and place. A reviewer recording a finding and then repeating
 * it says the same sentence twice, so the subject is the identity; it
 * is compared loosely enough to survive the reviewer tidying its
 * punctuation, and no more loosely than that, because two findings
 * genuinely can share a subject.
 *
 * The place is the file alone rather than the whole anchor. A reviewer
 * that records against a file and then pins a line in its answer has
 * refined one finding, not found a second, and a byte-identical anchor
 * comparison would report both.
 *
 * A finding that names no file matches one that does, on the same
 * subject. That is not looseness for its own sake: a location now
 * degrades to the change rather than dropping the finding, so the
 * commonest shape of a repeat is a reviewer recording a remark
 * mid-investigation without a location and then naming the file
 * properly in its answer. Keyed on the path alone those are two
 * buckets, and the round would file one observation twice, in exactly
 * the case the journal exists to serve.
 *
 * Two genuinely different findings that share a folded subject and
 * differ only in that one named no file are folded together by this.
 * That is the trade, and it is the right way round: saying one thing
 * twice is noise a reader dismisses, while the alternative is deciding
 * two remarks are distinct because one of them was vague.
 */
export function saysTheSame(
	one: Omit<Finding, "id">,
	two: Omit<Finding, "id">,
): boolean {
	if (foldedSubject(one) !== foldedSubject(two)) return false;
	const here = pathOf(one);
	const there = pathOf(two);
	return here === "" || there === "" || here === there;
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

	// `title` and `body` are read as well, because a reviewer writing a
	// finding down under pressure reaches for the words it already
	// knows. Measured: one council lost twelve findings from a single
	// reviewer, every one of them well formed, because it said `title`
	// where the contract says `subject`. They were the sharpest
	// findings in the round. The contract is still the contract, and
	// this is the same bargain the label and the location already
	// strike: a finding is dropped when it says nothing, never when it
	// said something under a name we did not expect.
	const subject = wireText(entry.subject) ?? wireText(entry.title);
	if (subject === undefined) {
		warnings.push(`${at} has no subject, so it was dropped.`);
		return undefined;
	}

	const { label, given } = readLabel(entry.label, at, warnings);
	const anchor = readAnchor(entry.location, at, witness, warnings);

	return {
		anchor,
		label,
		subject,
		discussion: discussionWith(
			wireText(entry.discussion) ?? wireText(entry.body) ?? "",
			given,
		),
		origin,
		...readSeverity(entry.severity, at, warnings),
		...readConfidence(entry.confidence, at, warnings),
		...readRaisedBy(entry.raisedBy, at, warnings),
	};
}

/**
 * Where the finding points, as precisely as what it said allows.
 *
 * Never nothing. Precision is the part a reviewer is most likely to
 * get wrong under pressure, and it is the part that matters least: a
 * remark about the wrong level of the change is still the remark,
 * while a remark thrown away for pointing loosely is gone. So a line
 * with no line falls back to the file, a file with no file falls back
 * to the change, and each says so.
 */
function readAnchor(
	value: unknown,
	at: string,
	witness: string | undefined,
	warnings: string[],
): Anchor {
	const stamp = witness === undefined ? {} : { witness };
	if (!isRecord(value)) {
		warnings.push(
			`${at} names no location, so it was kept against the change.`,
		);
		return { subject: "change", ...stamp };
	}

	const kind = wireText(value.kind);
	if (kind === "global") return { subject: "change", ...stamp };

	// `path` alongside `file`, for the same reason `line` is read
	// alongside `start` two branches down: it is the word a reviewer
	// reaches for, and the anchor this produces calls it `path`.
	const path = wireText(value.file) ?? wireText(value.path);
	if (kind === "file") {
		if (path === undefined) {
			warnings.push(
				`${at} is a file finding with no file, so it was kept against the change.`,
			);
			return { subject: "change", ...stamp };
		}
		return { subject: "file", path, ...stamp };
	}

	if (kind === "line") {
		if (path === undefined) {
			warnings.push(
				`${at} is a line finding with no file, so it was kept against the change.`,
			);
			return { subject: "change", ...stamp };
		}
		// `line` is read as well as `start`, because it is the word the
		// anchor this produces uses, and a reviewer naming a single
		// line reaches for it. Measured on a real journal: nine of
		// eleven recorded findings said `line`, and reading only
		// `start` cost every one of them the line it had named.
		const start = wireWhole(value.start) ?? wireWhole(value.line);
		const end = wireWhole(value.end) ?? start;
		if (start === undefined || end === undefined) {
			warnings.push(
				`${at} is a line finding with no line, so it was kept against the whole file.`,
			);
			return { subject: "file", path, ...stamp };
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

	// A path with an unreadable kind still says where to look, so the
	// kind costs the precision and not the location.
	if (path !== undefined) {
		warnings.push(
			`${at} has location kind "${kind ?? "none"}", which is not line, file or global, so it was kept against the whole file.`,
		);
		return { subject: "file", path, ...stamp };
	}
	warnings.push(
		`${at} has location kind "${kind ?? "none"}", which is not line, file or global, so it was kept against the change.`,
	);
	return { subject: "change", ...stamp };
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

/**
 * A label, or the most neutral one plus a warning saying which word
 * was used instead.
 *
 * Guessing what a reviewer meant would put words in their mouth, so
 * nothing is guessed: an unreadable label becomes a note, which
 * asserts less than any other, and their own word is named in the
 * warning so a reader can see it.
 *
 * Dropping the finding was the older reading of the same principle
 * and it cost far more than it protected. Measured on the journal's
 * first real council: one reviewer of seven labelled its entries
 * defect, testing and design, and every one of its eleven recorded
 * findings was thrown away. It answered anyway, so nothing was lost
 * that time. Had it been stopped, the journal would have rescued
 * nothing in exactly the case it exists for.
 */
function readLabel(
	value: unknown,
	at: string,
	warnings: string[],
): { label: ConventionalLabel; given?: string } {
	const given = wireText(value);
	// Folded, because a capital is not a different label and reading
	// "Issue" as unrecognized would cost a decoration over a shift key.
	const folded = given?.toLowerCase();
	if (folded !== undefined && LABELS.includes(folded)) {
		return { label: folded as ConventionalLabel };
	}
	warnings.push(
		`${at} is labelled "${given ?? "nothing"}", which is not one of ${LABELS.join(", ")}, so it was kept as a note saying so.`,
	);
	return { label: "note", ...(given === undefined ? {} : { given }) };
}

/**
 * The discussion, carrying the reviewer's own label when it was not
 * one we know.
 *
 * Said in the finding rather than only in a warning, because a warning
 * lives for one message. It is not persisted on the run, the finding
 * that reaches the store holds only "note", and the judge is shown the
 * label and nothing else. Without this the defence of defaulting to a
 * note, that their own word survives for a reader, is true of the tool
 * answer alone and false everywhere the finding actually travels.
 */
function discussionWith(discussion: string, given?: string): string {
	if (given === undefined) return discussion;
	const said = `The reviewer labelled this "${given}", which is not one of the conventional labels, so it is kept as a note.`;
	return discussion === "" ? said : `${discussion}\n\n${said}`;
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
