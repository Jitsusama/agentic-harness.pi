/**
 * Each use of a verb and what became of it, one JSON line each, so a
 * verb nobody keeps can be found from the file and let go: `asked` when
 * its prompt is built, then `accepted`, `undone` or `dismissed` as the
 * launcher says.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** What the launcher may say became of a use. */
export const OUTCOMES = ["accepted", "undone", "dismissed"] as const;

/** What a line says of a use: asked, or what became of it. */
export type UseOutcome = "asked" | (typeof OUTCOMES)[number];

/** One line of the uses file. */
interface UseLine {
	readonly at: string;
	readonly use: string;
	readonly verb: string;
	readonly outcome: UseOutcome;
}

/** Adds one line to the uses file, making its folder when it's missing. */
export function recordUse(file: string, line: UseLine): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}
