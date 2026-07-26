/**
 * Reading a captured run back.
 *
 * Presentation, and only presentation: nothing here decides
 * what was captured, only how much of it is worth putting in
 * front of a reader at once.
 */

import type { Recorded } from "./buffer.js";
import type { LogEntry } from "./console.js";

/** A window onto a buffer, with what the buffer lost. */
export interface Captured<T> {
	readonly entries: readonly Recorded<T>[];
	readonly dropped: number;
	readonly cursor: number;
}

/** Levels worst first, so the tally reads in the order that matters. */
const LEVEL_ORDER = [
	"error",
	"warning",
	"assert",
	"info",
	"log",
	"debug",
	"verbose",
	"trace",
];

/** How wide the level column is before the text starts. */
const LEVEL_WIDTH = 8;

export function renderLogs(captured: Captured<LogEntry>): string {
	if (captured.entries.length === 0 && captured.dropped === 0) {
		return "The page has not logged anything.";
	}

	const base = sharedBase(captured.entries);
	const lines = [tally(captured.entries)];
	if (base) lines.push(`Paths below are under ${base}`);
	lines.push("");

	for (const { seq, item } of captured.entries) {
		const source =
			item.source === "console" || item.source === "exception"
				? ""
				: ` (${item.source})`;
		lines.push(
			`${String(seq).padStart(4)}  ` +
				`${item.level.padEnd(LEVEL_WIDTH)} ${item.text}${source}`,
		);
		if (item.origin) {
			lines.push(`${" ".repeat(8)}${shorten(item.origin, base)}`);
		}
		const stack = usefulStack(item.stack, item.origin);
		if (stack) lines.push(shorten(stack, base));
	}

	if (captured.dropped > 0) {
		lines.push(
			"",
			`${captured.dropped} earlier entries were dropped to keep the ` +
				"buffer bounded.",
		);
	}
	lines.push(
		"",
		`To read only what comes next, ask again with since: ${captured.cursor}.`,
	);
	return lines.join("\n");
}

/**
 * A stack worth printing.
 *
 * A one-frame stack under an origin that already names that
 * frame says the same thing twice, which is the one thing a
 * reader scanning for the second location cannot afford.
 */
function usefulStack(
	stack: string | undefined,
	origin: string | undefined,
): string | undefined {
	if (!stack) return undefined;
	const frames = stack.split("\n").filter((line) => line.trim());
	if (frames.length === 1 && origin && frames[0]?.includes(origin)) {
		return undefined;
	}
	return stack;
}

/**
 * The directory most origins share.
 *
 * A page's messages nearly all come from the same document, and
 * repeating its full url on every line spends the budget saying
 * what the reader learned on the first line. Deliberately the
 * most common directory rather than the one they all share: a
 * single failed image at the site root would otherwise drag the
 * shared prefix down to the scheme and every other line would
 * pay for it. Origins outside the hoist keep their full path,
 * because a name relative to a base they do not sit under
 * would point at nothing.
 */
function sharedBase(
	entries: readonly Recorded<LogEntry>[],
): string | undefined {
	const directories = entries
		.map(({ item }) => item.origin)
		.filter((origin): origin is string => Boolean(origin))
		.map((origin) => origin.slice(0, origin.lastIndexOf("/") + 1))
		// A bare scheme is not a path worth hoisting.
		.filter((directory) => directory.length > "https://".length);

	const counts = new Map<string, number>();
	for (const directory of directories) {
		counts.set(directory, (counts.get(directory) ?? 0) + 1);
	}

	let best: string | undefined;
	let bestCount = 1;
	for (const [directory, count] of counts) {
		if (count > bestCount) {
			best = directory;
			bestCount = count;
		}
	}
	return best;
}

/** An origin with the shared base taken off the front. */
function shorten(text: string, base: string | undefined): string {
	return base ? text.split(base).join("") : text;
}

/** How many of each level, worst first. */
function tally(entries: readonly Recorded<LogEntry>[]): string {
	const counts = new Map<string, number>();
	for (const { item } of entries) {
		counts.set(item.level, (counts.get(item.level) ?? 0) + 1);
	}

	const ranked = [...counts.entries()].sort((left, right) => {
		const leftRank = LEVEL_ORDER.indexOf(left[0]);
		const rightRank = LEVEL_ORDER.indexOf(right[0]);
		return (
			(leftRank < 0 ? LEVEL_ORDER.length : leftRank) -
			(rightRank < 0 ? LEVEL_ORDER.length : rightRank)
		);
	});

	if (ranked.length === 0) return "Nothing in this window.";
	return `${ranked
		.map(([level, count]) => `${count} ${count === 1 ? level : plural(level)}`)
		.join(", ")}.`;
}

/** The plural of a level name. */
function plural(level: string): string {
	return level.endsWith("s") ? level : `${level}s`;
}
