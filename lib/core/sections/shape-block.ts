/**
 * Turns shape violations into one instruction the author can act on:
 * every broken rule, where it is, its limit and what was found, with
 * what to do instead. One refusal that says everything costs one
 * rewrite; a refusal per rule costs one each.
 */

import type { ShapeViolation } from "./shape.ts";

/** The section's name as a reader says it: the heading without hashes or emoji. */
function nameOf(heading: string): string {
	if (heading === "") return "The text above the first heading";
	return heading.replace(/^#+\s+/, "").replace(/^[^\p{L}\p{N}]+\s*/u, "");
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** One line per violation, saying what to change. */
function line(v: ShapeViolation): string {
	const name = nameOf(v.section);
	const quoted = v.excerpt ? ` ("${v.excerpt}")` : "";
	switch (v.rule) {
		case "words":
			return `${name} is ${v.actual} words; it may be at most ${v.limit}, so cut ${plural(v.actual - v.limit, "word", "words")}. Keep what the reader needs and cut the rest.`;
		case "sentences":
			return `${name} is ${plural(v.actual, "sentence", "sentences")}; it may be at most ${v.limit}.`;
		case "codeSpans":
			return v.limit === 0
				? `${name} has ${plural(v.actual, "code span", "code spans")}; it may have none. Say what the code does in plain words.`
				: `${name} has ${v.actual} code spans; it may have at most ${v.limit}. Name an identifier only when the reader will type or set it.`;
		case "bullets":
			return v.limit === 0
				? `${name} is a list; write it as prose, saying how one thing leads to the next.`
				: `${name} has ${v.actual} list items; it may have at most ${v.limit}.`;
		case "links":
			return `${name} has ${plural(v.actual, "link", "links")}; it may have ${v.limit === 0 ? "none" : `at most ${v.limit}`}. Put links in a later section.`;
		case "artifactLists":
			return `${name} lists artifacts${quoted}. Say what behaviour changed instead; the diff already shows which files did.`;
		case "sentenceWords":
			return `${name} has a ${v.actual}-word sentence${quoted}; split it so no sentence passes ${v.limit} words.`;
		case "empty":
			return `${name} is empty; say what it is for.`;
		case "above":
			return `${name} must be empty${quoted}; the body opens with the TL;DR. Put an issue line or stack note straight after the TL;DR's text.`;
		case "opener":
			return `${name} opens with "${v.word}"; open with the thing that changed.`;
		case "emphasis":
			return `${name} uses bold; leave emphasis out of it.`;
		case "depth":
			return `${name} has ${plural(v.actual, "subheading", "subheadings")}, which only a change of ${v.limit} changed lines or more may carry, and this one gets none: ${v.why ?? "its size is not known"}. Fold the parts into the section's own prose.`;
		case "parts":
			return `${name} has ${v.actual} parts; it may have at most ${v.limit}. Merge the smallest into their neighbours.`;
		case "tableRows":
			return `${name} has a table of ${v.actual} rows; it may have at most ${v.limit}. Keep the results a reader compares and say the rest in prose.`;
		case "cellWords":
			return `${name} has a table cell of ${v.actual} words; a cell may hold at most ${v.limit}. A table holds values; the reasons go in prose.`;
		case "tableNumbers":
			return `${name} has ${plural(v.actual, "table row", "table rows")} with no number${quoted}. A results table holds measured values; say anything else in prose.`;
		case "tableAfter":
			return `${name} ends on a table; follow it with a sentence saying where those checks stop.`;
		case "tablePlace":
			return `${name} has ${plural(v.actual, "table", "tables")}; only Validation may hold one, for measured results. Say the rest in prose.`;
		case "docLinks":
			return `${name} points to a document in the repository${quoted}. The description has to stand alone, so bring what the reader needs from it into the body.`;
	}
}

/** Format shape violations into a block message, or "" if there are none. */
export function formatShapeBlock(
	violations: ShapeViolation[],
	entityLabel: string,
	skill: string,
): string {
	if (violations.length === 0) return "";
	return [
		`This ${entityLabel} body is not yet in the shape the ${skill} skill`,
		"sets for a reader who will not open the diff. Fix every point and",
		"try again:",
		"",
		...violations.map((v) => `- ${line(v)}`),
		"",
		`These checks count and match exactly, so they cannot tell whether the description is true. Before sending it again, read it through the ${skill} skill's Before You Submit questions.`,
	].join("\n");
}
