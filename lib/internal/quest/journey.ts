/**
 * Where a quest's Journey lives: `JOURNEY.md` beside the README, newest
 * entry first, with the README's Journey section reduced to one line
 * that points at it.
 *
 * The Journey was most of every busy README (176 KB of the mission's
 * 225 KB), and every session that read a README to learn what a quest
 * is for paid for its whole history. Kept apart, the README says what
 * the quest is and the Journey is read only when asked for.
 *
 * It sat first in `attachments/journey.md`, while the record and the
 * backup kept only the README, ID documents and cited attachments.
 * Both now keep `JOURNEY.md` as part of the record, so it moved up
 * beside the README. A file still at the old place is read as the
 * newer part of the Journey, since only a session on older code
 * writes there, and the next sweep folds it in.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JourneyEntry } from "../../quest/types.ts";

/** The Journey's path, relative to its quest's folder. */
export const JOURNEY_FILE = "JOURNEY.md";

/** Where the Journey lived before it moved beside the README. */
export const FORMER_JOURNEY_FILE = "attachments/journey.md";

const pointerTo = (file: string) => `Kept in [${file}](${file}), newest first.`;

/** The one line a README's Journey section holds. */
export const JOURNEY_POINTER = pointerTo(JOURNEY_FILE);

/** Whether a README line is the Journey's pointer, at either place. */
export function isJourneyPointer(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed === JOURNEY_POINTER || trimmed === pointerTo(FORMER_JOURNEY_FILE)
	);
}

/** The Journey file's own title. */
export const JOURNEY_TITLE = "# 🌄 Journey";

/** A README's Journey heading, with or without its glyph. */
export const JOURNEY_HEADING =
	/^##\s+(?:[\u{1F300}-\u{1FFFF}]\s+)?Journey\s*$/u;

const ANY_H2 = /^##\s+/;
const ENTRY = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*:\s*(.*)$/;
const CONTINUATION = /^\s+/;

/** The absolute path of a quest's Journey file. */
export function journeyFilePath(questDir: string): string {
	return join(questDir, JOURNEY_FILE);
}

/** The absolute path of the Journey's former file. */
export function formerJourneyFilePath(questDir: string): string {
	return join(questDir, FORMER_JOURNEY_FILE);
}

/**
 * The lines of a quest's Journey file below its title, with leading
 * blank lines dropped; empty when there is no file yet. A file still
 * at the former place comes first, being newer.
 */
export function readJourneyFile(questDir: string): string[] {
	return [
		...bodyAt(formerJourneyFilePath(questDir)),
		...bodyAt(journeyFilePath(questDir)),
	];
}

function bodyAt(path: string): string[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// No file here: a quest that has never been journaled since the
		// move, or one already moved, which reads as nothing.
		return [];
	}
	return journeyBody(text);
}

/** The lines of a Journey file's text below its title. */
export function journeyBody(text: string): string[] {
	const lines = text.replace(/\n+$/, "").split("\n");
	let start = 0;
	if (lines[0]?.startsWith("# ")) start = 1;
	while (start < lines.length && lines[start].trim() === "") start++;
	return lines.slice(start);
}

/** Render a Journey file from the lines below its title. */
export function renderJourneyFile(body: string[]): string {
	return body.length === 0
		? `${JOURNEY_TITLE}\n`
		: `${JOURNEY_TITLE}\n\n${body.join("\n")}\n`;
}

/**
 * The lines of a README's Journey section, between its heading and the
 * next `##`, or undefined when it has none.
 */
export function readmeJourneySection(
	readme: string,
): { start: number; end: number; lines: string[] } | undefined {
	const lines = readme.split("\n");
	const heading = lines.findIndex((l) => JOURNEY_HEADING.test(l));
	if (heading < 0) return undefined;
	let end = heading + 1;
	while (end < lines.length && !ANY_H2.test(lines[end])) end++;
	return { start: heading, end, lines: lines.slice(heading + 1, end) };
}

/**
 * Every line of a quest's Journey, newest first: whatever still sits
 * in the README's section (entries core's verbs append there until
 * the fold, not yet swept), then the Journey file.
 */
export function questJourneyLines(questDir: string, readme: string): string[] {
	const section = readmeJourneySection(readme)?.lines ?? [];
	// The pointer, and comment lines such as the citations the sweep
	// carries, are the section's machinery rather than its entries.
	const unswept = section.filter(
		(l) => !isJourneyPointer(l) && !/^<!--.*-->$/.test(l.trim()),
	);
	while (unswept.length > 0 && unswept[0].trim() === "") unswept.shift();
	while (unswept.length > 0 && unswept[unswept.length - 1].trim() === "")
		unswept.pop();
	return [...unswept, ...readJourneyFile(questDir)];
}

/**
 * Parse dated Journey entries out of lines: a `- **YYYY-MM-DD**:`
 * bullet and the indented lines that continue it.
 */
export function journeyEntriesFrom(lines: readonly string[]): JourneyEntry[] {
	const entries: JourneyEntry[] = [];
	let current: JourneyEntry | undefined;
	for (const line of lines) {
		const m = ENTRY.exec(line);
		if (m) {
			if (current) entries.push(current);
			current = { date: m[1], prose: m[2].trim() };
			continue;
		}
		if (current && CONTINUATION.test(line) && line.trim()) {
			current.prose += `\n${line.trim()}`;
			continue;
		}
		if (current && line.trim() !== "") {
			entries.push(current);
			current = undefined;
		}
	}
	if (current) entries.push(current);
	return entries;
}

/** A quest's newest Journey entries, at most `limit` of them. */
export function recentJourney(
	questDir: string,
	readme: string,
	limit: number,
): JourneyEntry[] {
	return journeyEntriesFrom(questJourneyLines(questDir, readme)).slice(
		0,
		limit,
	);
}
