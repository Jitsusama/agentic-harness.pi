/**
 * The excerpts as they are appended to a summary: grouped by kind, in
 * the order kinds are listed, each group in the order it was said, and
 * each paragraph quoted with who said it.
 *
 * The summary above them is the account of where the work stands, and
 * the excerpts are its evidence, so where the two disagree the summary
 * is the one to believe: it was written knowing everything after them.
 */

import type { Candidate } from "./candidates.ts";
import { KIND_DEFINITIONS, SELECTION_KINDS } from "./kinds.ts";

/** The heading the excerpts appear under. */
export const EXCERPTS_HEADING = "## Excerpts Kept Verbatim";

/** The excerpts as markdown to append to a summary, or empty with none. */
export function renderExcerpts(chosen: readonly Candidate[]): string {
	if (chosen.length === 0) return "";
	const sections: string[] = [];
	for (const kind of SELECTION_KINDS) {
		const group = chosen
			.filter((c) => c.kind === kind)
			.sort((a, b) => a.order - b.order);
		if (group.length === 0) continue;
		const quotes = group.map(
			(c) =>
				`${c.unit.speaker === "user" ? "User" : "Assistant"}:\n${quoted(c.unit.text)}`,
		);
		sections.push(
			`### ${KIND_DEFINITIONS[kind].heading}\n\n${quotes.join("\n\n")}`,
		);
	}
	return [
		"",
		"",
		EXCERPTS_HEADING,
		"",
		"Quoted from the conversation this summary replaces, in the words they were said in. Where one disagrees with the summary above, the summary is right: it was written knowing what came after.",
		"",
		sections.join("\n\n"),
		"",
	].join("\n");
}

function quoted(text: string): string {
	return text
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
}
