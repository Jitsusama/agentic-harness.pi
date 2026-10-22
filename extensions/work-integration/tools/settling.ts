/**
 * What a replay settled by itself, said under its answer.
 *
 * A replay through Markdown that both sides only added to now carries on by
 * itself (core's `work/appends.ts`), and so changes files nobody edited by
 * hand: it keeps both additions, moves the replayed side's entries to free
 * numbers, and rewrites the halted commit's citations of them. The answer
 * names each file and every number moved, so nothing changed unseen. Lines
 * the branch's other commits added that still cite a moved number cannot be
 * rewritten mid-replay, so those are named as the one thing left to do.
 */

import type {
	SettledFile,
	StaleCitation,
} from "@jitsusama/agentic-harness.core/work";
import { count } from "../../../lib/ui/count.ts";
import { GLYPH } from "../render.ts";

/** Lines saying what a replay settled and what still cites a moved number. */
export function settlingLines(
	settled: readonly SettledFile[] = [],
	stale: readonly StaleCitation[] = [],
): string[] {
	const lines: string[] = [];
	for (const file of settled) {
		lines.push(
			`   ${GLYPH.clean} ${file.path}: both sides only added, at ${count(file.hunks, "place")}, so both were kept, what had landed first.`,
		);
		for (const move of file.renumbered) {
			lines.push(
				`     ${move.from} is now ${move.to}, and so are its citations.`,
			);
		}
	}
	if (stale.length > 0) {
		lines.push(
			"",
			`${GLYPH.dirty} Lines this branch added still cite a number that moved. Fix them in a commit of their own:`,
			...stale.map(
				(line) => `   ${line.path}:${line.line} cites ${line.cites}`,
			),
		);
	}
	return lines;
}
