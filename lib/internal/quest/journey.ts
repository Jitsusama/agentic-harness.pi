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
 * beside the README. Until every session runs the new code, one still
 * on the old code writes the old place, so either file may hold the
 * newest entries: the two are read merged by date, and the next sweep
 * folds the old one in.
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
const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s/;
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
 * at the former place is merged in by date.
 */
export function readJourneyFile(questDir: string): string[] {
	return mergeJourneyBodies(
		bodyAt(journeyFilePath(questDir)),
		bodyAt(formerJourneyFilePath(questDir)),
	);
}

/** A Journey body cut into its parts, for merging two of them. */
interface JourneyParts {
	/** Lines before the first entry. */
	lead: string[];
	/** Each dated entry with the lines that follow it. */
	entries: { date: string; lines: string[] }[];
	/** Reference-style link definitions, which sit at the end. */
	definitions: string[];
}

function partsOf(body: readonly string[]): JourneyParts {
	const parts: JourneyParts = { lead: [], entries: [], definitions: [] };
	for (const line of body) {
		const entry = ENTRY.exec(line);
		const current = parts.entries.at(-1);
		if (entry) parts.entries.push({ date: entry[1], lines: [line] });
		else if (DEFINITION.test(line)) parts.definitions.push(line);
		else if (current) current.lines.push(line);
		else parts.lead.push(line);
	}
	for (const entry of parts.entries) {
		while (entry.lines.at(-1)?.trim() === "") entry.lines.pop();
	}
	return parts;
}

/**
 * Two Journey bodies as one, newest first: entries merged by date,
 * each body keeping its own order, and `first`'s entry ahead on a
 * tie; link definitions from both, one per label. A body that is
 * empty leaves the other exactly as it was.
 */
export function mergeJourneyBodies(
	first: readonly string[],
	second: readonly string[],
): string[] {
	if (second.length === 0) return [...first];
	if (first.length === 0) return [...second];
	const a = partsOf(first);
	const b = partsOf(second);
	const merged: string[] = [...trimBlank(a.lead), ...trimBlank(b.lead)];
	let i = 0;
	let j = 0;
	while (i < a.entries.length || j < b.entries.length) {
		const takeFirst =
			j >= b.entries.length ||
			(i < a.entries.length && a.entries[i].date >= b.entries[j].date);
		merged.push(...(takeFirst ? a.entries[i++] : b.entries[j++]).lines);
	}
	const labels = new Set<string>();
	const definitions = [...a.definitions, ...b.definitions].filter((line) => {
		const label = (DEFINITION.exec(line)?.[1] ?? "").toLowerCase();
		if (labels.has(label)) return false;
		labels.add(label);
		return true;
	});
	if (definitions.length > 0) merged.push("", ...definitions);
	return merged;
}

function trimBlank(lines: readonly string[]): string[] {
	const out = [...lines];
	while (out[0]?.trim() === "") out.shift();
	while (out.at(-1)?.trim() === "") out.pop();
	return out;
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
