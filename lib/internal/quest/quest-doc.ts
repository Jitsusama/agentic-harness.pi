/**
 * Quest document model: parse a quest README into its
 * structured projections.
 *
 * What we extract:
 *
 * - Front-matter (delegated to frontmatter.ts).
 * - Title: first H1 of the body.
 * - Section snippets: first paragraph of Summary and
 *   Purpose, recent Journey entries, Cast bullets.
 * - Milestone checkboxes: total and done count.
 * - Inline references: bare quest/document IDs and any
 *   text the registered ref types match.
 *
 * We do not try to make the parser idempotent over the
 * body. Writers regenerate the structured sections; free
 * prose is preserved by mutating the doc's `body` string
 * directly.
 */

import type {
	CastEntry,
	JourneyEntry,
	QuestDoc,
	QuestFrontMatter,
} from "../../quest/types.js";
import { parseAllRefs } from "../../refs/index.js";
import { parseQuestFrontMatter } from "./frontmatter.js";
import { findIds, findIdsWithRelation, type IdMention } from "./id.js";

const SECTION_HEADERS = {
	summary: /^##\s+(?:[\u{1F300}-\u{1FFFF}]\s+)?Summary\s*$/u,
	purpose: /^##\s+(?:[\u{1F300}-\u{1FFFF}]\s+)?Purpose\s*$/u,
	cast: /^##\s+(?:[\u{1F300}-\u{1FFFF}]\s+)?Cast\s*$/u,
	journey: /^##\s+(?:[\u{1F300}-\u{1FFFF}]\s+)?Journey\s*$/u,
	milestones: /^##\s+(?:[\u{1F300}-\u{1FFFF}]\s+)?Milestones\s*$/u,
	spirit: /^##\s+(?:[\u{1F300}-\u{1FFFF}]\s+)?Spirit\s*$/u,
	outcomes: /^##\s+(?:[\u{1F300}-\u{1FFFF}]\s+)?Outcomes\s*$/u,
	context: /^##\s+(?:[\u{1F300}-\u{1FFFF}]\s+)?Context\s*$/u,
} as const;

const ANY_H2 = /^##\s+/;

/** Parse a quest README and return the structured doc. */
export function parseQuestDoc(text: string): QuestDoc | undefined {
	const parsed = parseQuestFrontMatter(text);
	if (!parsed) return undefined;
	return {
		frontMatter: parsed.frontMatter,
		body: parsed.body,
		title: extractTitle(parsed.body),
	};
}

/** Extract the first H1 from a body. */
export function extractTitle(body: string): string | undefined {
	const match = /^#\s+(.+)$/m.exec(body);
	return match ? match[1].trim() : undefined;
}

/**
 * Extract the lines of a named section from a body. Returns
 * the lines between the matching `## Section` header and
 * the next `## ` header (or end of body). The header line
 * itself is excluded.
 */
export function extractSection(
	body: string,
	header: keyof typeof SECTION_HEADERS,
): string[] {
	const headerRegex = SECTION_HEADERS[header];
	const lines = body.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (headerRegex.test(lines[i])) {
			start = i + 1;
			break;
		}
	}
	if (start === -1) return [];
	let end = lines.length;
	for (let i = start; i < lines.length; i++) {
		if (ANY_H2.test(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end);
}

/** First paragraph (until blank line) of a section. */
export function extractSectionParagraph(
	body: string,
	header: keyof typeof SECTION_HEADERS,
): string | undefined {
	const sectionLines = extractSection(body, header);
	const paragraph: string[] = [];
	for (const line of sectionLines) {
		if (line.trim() === "") {
			if (paragraph.length > 0) break;
			continue;
		}
		paragraph.push(line);
	}
	return paragraph.length > 0 ? paragraph.join("\n").trim() : undefined;
}

/** Parse the Cast section's role-prefix bullets. */
export function extractCast(body: string): CastEntry[] {
	const lines = extractSection(body, "cast");
	const bullets: CastEntry[] = [];
	const bulletRegex = /^-\s+\*\*([\w-]+)\*\*:\s*(.+)$/;
	for (const line of lines) {
		const m = bulletRegex.exec(line.trim());
		if (!m) continue;
		const role = m[1].toLowerCase();
		const rest = m[2].trim();
		// The subject is the leading person token (a handle
		// like @joel.gerber or a name like Joel Gerber).
		// Names can be multi-word; we stop at the first
		// sentence break (period followed by a space or
		// end-of-string) or a comma.
		let subjectEnd = rest.length;
		const sentenceBreak = /\.(?:\s|$)/.exec(rest);
		if (sentenceBreak) subjectEnd = sentenceBreak.index;
		const commaBreak = rest.indexOf(",");
		if (commaBreak >= 0 && commaBreak < subjectEnd) subjectEnd = commaBreak;
		const subject = rest.slice(0, subjectEnd).trim();
		const prose = rest
			.slice(subjectEnd)
			.replace(/^[.\s,]+/, "")
			.trim();
		bullets.push({ role, subject, prose });
	}
	return bullets;
}

/** Parse the Journey section's dated entries. */
export function extractJourney(body: string): JourneyEntry[] {
	const lines = extractSection(body, "journey");
	const entries: JourneyEntry[] = [];
	const dateRegex = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*:\s*(.*)$/;
	const continuationRegex = /^\s+/;
	let current: JourneyEntry | undefined;
	for (const line of lines) {
		const m = dateRegex.exec(line);
		if (m) {
			if (current) entries.push(current);
			current = { date: m[1], prose: m[2].trim() };
			continue;
		}
		if (current && (continuationRegex.test(line) || line.trim() === "")) {
			if (line.trim()) current.prose += `\n${line.trim()}`;
		}
	}
	if (current) entries.push(current);
	return entries;
}

/** Count Milestones section checkboxes. */
export function milestoneProgress(body: string): {
	total: number;
	done: number;
} {
	const section = extractSection(body, "milestones").join("\n");
	const rx = /^\s*-\s+\[([ xX])\]/gm;
	let total = 0;
	let done = 0;
	for (let m = rx.exec(section); m !== null; m = rx.exec(section)) {
		total++;
		if (m[1].toLowerCase() === "x") done++;
	}
	return { total, done };
}

/**
 * Pull every inline reference out of the body: bare quest
 * IDs and any pattern recognised by a registered ref type.
 *
 * `ids` lists every ID found, in order of first appearance.
 * `idMentions` adds the `→` sigil relation: an id
 * preceded by `→` is marked `produced`; bare ids are
 * marked `reference`. Consumers that don't care about the
 * relation can keep using `ids`.
 */
export interface ExtractedMentions {
	/** Quest, plan, research, brief or report IDs. */
	ids: string[];
	/** Same IDs, classified as produced-by or bare reference. */
	idMentions: IdMention[];
	/** Refs through the registered ref types. */
	refs: Array<{ type: string; value: string }>;
}

export function extractMentions(body: string): ExtractedMentions {
	const idMentions = findIdsWithRelation(body);
	return {
		ids: findIds(body),
		idMentions,
		refs: parseAllRefs(body),
	};
}

/**
 * Quick projection used by the `quest show` action. Combines
 * the snippets the agent needs to synthesise a paragraph
 * about a quest.
 */
export interface QuestShowProjection {
	frontMatter: QuestFrontMatter;
	title?: string;
	summary?: string;
	purpose?: string;
	cast: CastEntry[];
	journey: JourneyEntry[];
	milestones: { total: number; done: number };
	mentions: ExtractedMentions;
}

export function projectQuestForShow(doc: QuestDoc): QuestShowProjection {
	return {
		frontMatter: doc.frontMatter,
		title: doc.title,
		summary: extractSectionParagraph(doc.body, "summary"),
		purpose: extractSectionParagraph(doc.body, "purpose"),
		cast: extractCast(doc.body),
		journey: extractJourney(doc.body),
		milestones: milestoneProgress(doc.body),
		mentions: extractMentions(doc.body),
	};
}
