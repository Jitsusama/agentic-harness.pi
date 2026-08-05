/**
 * A finding that belongs to a stack rather than to one change.
 *
 * Reviewing a stack one change at a time hides the findings that only
 * exist between changes: an interface introduced at the base and used
 * wrongly at the tip, a migration split so the middle change cannot
 * deploy on its own. Asking about the whole stack at once surfaces
 * those, but only if a finding can say it is about several changes.
 *
 * So a span, and not a duplicate on each change. Repeating one
 * observation on every change it touches makes a reader answer it
 * three times and leaves three places to resolve it, and the thing
 * that made it worth saying, that it is *between* them, is exactly
 * what gets lost.
 *
 * A span names refs rather than positions. A stack renumbers itself
 * every time somebody restacks it, so a finding recorded as "the
 * second change" is wrong as soon as anything lands underneath.
 */

import type { Finding, FindingOrigin } from "../finding.js";
import { readWireFinding } from "./harvest.js";
import { ANSWER_WAS_CUT_OFF, isRecord, readAnswer, wireText } from "./wire.js";

/** The changes a finding is about, in stack order. */
export interface FindingSpan {
	/** One ref for an ordinary finding, several for a cross-change one. */
	refs: string[];
}

/** A finding plus the changes it is about. */
export interface SpannedFinding {
	span: FindingSpan;
	finding: Omit<Finding, "id">;
}

/** What came out of one stack-wide answer. */
export interface StackHarvest {
	findings: SpannedFinding[];
	warnings: string[];
}

/**
 * Read a stack-wide answer, warning about what it dropped.
 *
 * `witnessFor` is asked for the witness of the change a finding is
 * said at, because each change has its own diff: checking a line
 * finding on the tip against the base's diff would degrade a perfectly
 * good anchor for no reason.
 */
export function harvestStackFindings(
	text: string,
	origin: FindingOrigin,
	stackRefs: readonly string[],
	witnessFor?: (ref: string) => string | undefined,
): StackHarvest {
	const { parsed, truncated } = readAnswer(text, "findings");
	const held = parsed?.findings;
	if (!Array.isArray(held)) {
		return {
			findings: [],
			warnings: [
				"Nothing in this answer parsed as a findings array, so no findings could be read from it. An answer with nothing to say should still say findings: [].",
			],
		};
	}

	const findings: SpannedFinding[] = [];
	const warnings: string[] = [];
	if (truncated) warnings.push(ANSWER_WAS_CUT_OFF);
	for (const [index, entry] of held.entries()) {
		const at = `findings[${index}]`;
		const span = readSpan(entry, at, stackRefs, warnings);
		if (span === undefined) continue;

		const read = readWireFinding(
			entry,
			at,
			origin,
			witnessFor?.(saidAt(span, stackRefs)),
		);
		warnings.push(...read.warnings);
		if (read.finding !== undefined) {
			findings.push({ span, finding: read.finding });
		}
	}
	return { findings, warnings };
}

/**
 * Where a span gets said.
 *
 * The earliest change it touches, because that is where the decision
 * was made and where a reader walking the stack meets it first. Saying
 * it at the tip sends somebody to the consequence and leaves them to
 * work back to the cause.
 */
export function saidAt(
	span: FindingSpan,
	stackRefs: readonly string[],
): string {
	const ordered = inStackOrder(span.refs, stackRefs);
	return ordered[0] ?? span.refs[0] ?? "";
}

/** The changes an entry claims to be about, or nothing plus a warning. */
function readSpan(
	entry: unknown,
	at: string,
	stackRefs: readonly string[],
	warnings: string[],
): FindingSpan | undefined {
	if (!isRecord(entry)) {
		warnings.push(`${at} is not an object, so it was dropped.`);
		return undefined;
	}

	const claimed = Array.isArray(entry.refs) ? entry.refs : [];
	const named = claimed.flatMap((value) => {
		const ref = wireText(value);
		return ref === undefined ? [] : [ref];
	});

	const known = named.filter((ref) => stackRefs.includes(ref));
	const unknown = named.filter((ref) => !stackRefs.includes(ref));
	if (unknown.length > 0) {
		// Dropping the ref rather than the finding when others survive:
		// a reviewer that named three changes and got one wrong still
		// saw something real about the other two.
		warnings.push(
			`${at} names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is not a change" : "are not changes"} in this stack, so ${unknown.length === 1 ? "it was" : "they were"} left out.`,
		);
	}

	if (known.length === 0) {
		warnings.push(
			`${at} names no change in this stack, so it was dropped: a finding nobody can place is a finding nobody can read.`,
		);
		return undefined;
	}

	return { refs: inStackOrder(known, stackRefs) };
}

/**
 * Refs in the order the stack reports them, roots before children.
 *
 * A span reported tip-first would read backwards against the stack it
 * describes, and the order a model happened to list them in carries no
 * meaning worth preserving.
 */
function inStackOrder(
	refs: readonly string[],
	stackRefs: readonly string[],
): string[] {
	const unique = [...new Set(refs)];
	return unique.sort((a, b) => stackRefs.indexOf(a) - stackRefs.indexOf(b));
}
