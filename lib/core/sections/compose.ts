/**
 * A PR body built from its four sections as fields, and read back into
 * them.
 *
 * A tool that takes the sections as separate fields cannot be handed a
 * body with the wrong headings, the wrong order or something above the
 * TL;DR: it writes those itself, so the skeleton stops being something
 * the author can get wrong and a gate has to catch. What is left for
 * the author is the words, which is where their attention belongs.
 *
 * Reading a body back into fields is what lets an edit replace one
 * section and keep the rest, and lets a stack note move without
 * anybody rewriting the description around it.
 */

import { PR_SECTIONS } from "./sanctioned.ts";

/** The four sections of a PR description, as the text under each heading. */
export interface PrFields {
	/** What is different once this merges, and why it matters: 40 words at most. */
	readonly tldr: string;
	/** Why the change exists: the world before it. */
	readonly problem: string;
	/** What the change does about it, as behaviour, and the decision that mattered. */
	readonly solution: string;
	/** The evidence, claim by claim, and what is still unproven. */
	readonly validation: string;
}

/** The field names, in section order. */
export const PR_FIELDS = ["tldr", "problem", "solution", "validation"] as const;

type Field = (typeof PR_FIELDS)[number];

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const FENCE = /```[\s\S]*?```/g;
const VARIATION_SELECTOR = /\uFE0F/g;

const headingOf = (field: Field): string =>
	PR_SECTIONS[PR_FIELDS.indexOf(field)] ?? "";

/** A paragraph that is only context: the issue line, a stack note. */
function isContextBlock(block: string): boolean {
	return block
		.split("\n")
		.every((line) => /^\s*Part of #\d+/i.test(line) || /^\s*>/.test(line));
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const LITERAL_LINE = /^\s*(?:#{1,6}\s|>|\||\[[^\]]+\]:\s|<)/;

/**
 * Prose with its hard wraps taken out. GitHub renders every newline in
 * a PR body as a line break, so a paragraph wrapped at 72 columns, the
 * habit commit messages and markdown files teach, shows on the page as
 * ragged short lines. A wrapped line is joined onto the one before it;
 * list items, quotes, tables, headings, link definitions, HTML, fenced
 * code and a line ending in a hard break are left as written.
 */
export function unwrapProse(text: string): string {
	const out: string[] = [];
	let fenced = false;
	let joinable = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) {
			fenced = !fenced;
			out.push(line);
			joinable = false;
			continue;
		}
		const blank = line.trim() === "";
		const literal = fenced || blank || LITERAL_LINE.test(line);
		if (joinable && !literal && !LIST_ITEM.test(line)) {
			out[out.length - 1] = `${out.at(-1)} ${line.trim()}`;
		} else {
			out.push(line);
		}
		const last = out.at(-1) ?? "";
		joinable = !literal && !/(?: {2}|\\)$/.test(last);
	}
	return out.join("\n");
}

function composeSections(
	fields: Partial<PrFields>,
	context: readonly string[],
): string {
	const parts: string[] = [];
	for (const field of PR_FIELDS) {
		const raw = fields[field];
		const text = raw === undefined ? undefined : unwrapProse(raw.trim());
		if (text === undefined) continue;
		const under =
			field === "tldr"
				? [text, ...context.map((c) => c.trim())].filter(Boolean).join("\n\n")
				: text;
		parts.push(`${headingOf(field)}\n\n${under}`);
	}
	return `${parts.join("\n\n")}\n`;
}

/**
 * The body for four fields, headings and order written here. Context
 * blocks (the tracking-issue line, a stack note) go straight after the
 * TL;DR's text, so the first thing anybody sees, in a notification or a
 * link preview as much as on the page, is the TL;DR itself.
 */
export function composePrBody(
	fields: PrFields,
	context: readonly string[] = [],
): string {
	return composeSections(fields, context);
}

/**
 * The fields a body holds under the sanctioned headings, and the context
 * blocks under its TL;DR. A section the body does not have is absent
 * rather than empty, and a body in another shape reads as no fields.
 */
export function readPrFields(body: string): {
	fields: Partial<PrFields>;
	context: string[];
} {
	const masked = body.replace(FENCE, (m) => m.replace(/#/g, " "));
	const lines = body.split("\n");
	const maskedLines = masked.split("\n");
	const fields: Partial<Record<Field, string>> = {};
	const context: string[] = [];
	let current: Field | undefined;
	let held: string[] = [];

	const flush = () => {
		if (!current) return;
		const text = held.join("\n").trim();
		if (current === "tldr") {
			const blocks = text.split(/\n\s*\n/).map((b) => b.trim());
			context.push(...blocks.filter((b) => b && isContextBlock(b)));
			fields.tldr = blocks.filter((b) => b && !isContextBlock(b)).join("\n\n");
		} else {
			fields[current] = text;
		}
	};

	for (const [i, line] of lines.entries()) {
		const match = HEADING.exec(maskedLines[i] ?? "");
		if (!match) {
			held.push(line);
			continue;
		}
		flush();
		const heading = `${match[1]} ${match[2]}`.replace(VARIATION_SELECTOR, "");
		const at = PR_SECTIONS.findIndex(
			(h) => h.replace(VARIATION_SELECTOR, "") === heading,
		);
		current = at >= 0 ? PR_FIELDS[at] : undefined;
		held = [];
	}
	flush();
	return { fields, context };
}

/**
 * A body with some of its sections replaced, and its context replaced
 * when new context is given. Sections it is not given keep their text;
 * a section neither the body nor the edit has stays missing, so the
 * contract names it rather than this quietly inventing an empty one.
 */
export function reviseFields(
	body: string,
	edits: Partial<PrFields>,
	context?: readonly string[],
): string {
	const current = readPrFields(body);
	return composeSections(
		{ ...current.fields, ...edits },
		context ?? current.context,
	);
}
