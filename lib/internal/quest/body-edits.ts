/**
 * Edits to the body of a quest document that leave its front matter
 * byte for byte as it was: ticking a checkbox, replacing a section;
 * and the reads that find the same things without changing them: an
 * outline, one section, one item with its notes.
 *
 * Pure text in, text out. The verbs that call these hold the quest
 * lock around the read and the write, which is the point of having
 * verbs at all: a hand edit read the file, the workflow rewrote it
 * underneath, and the edit then missed its anchor. The reads share the
 * edits' matching, so what `show` finds is what `tick` and `section`
 * change.
 */

/** A document split where its front matter ends. */
export interface SplitDocument {
	/** Everything up to and including the closing fence's line. */
	head: string;
	body: string;
}

/** The fence that opens and closes front matter. */
const FENCE = "---";

/**
 * Split a document after its front matter, keeping the front matter
 * exactly as written. A document with none is all body.
 */
export function splitAtBody(text: string): SplitDocument {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== FENCE) return { head: "", body: text };
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === FENCE) {
			const head = `${lines.slice(0, i + 1).join("\n")}\n`;
			return { head, body: text.slice(head.length) };
		}
	}
	return { head: "", body: text };
}

/** A refusal, with what the caller should know to try again. */
export interface EditRefused {
	ok: false;
	reason: string;
}

/** An edit that went through, and whether it changed anything. */
export interface EditApplied {
	ok: true;
	body: string;
	changed: boolean;
	/** The line the edit touched, as it now reads. */
	line?: string;
	/** The section was not there and has been added at the end. */
	added?: boolean;
}

const CHECKBOX = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/;

/**
 * Set a checkbox item to done or not done, found by its text.
 *
 * The item is matched by its exact text first, ignoring case and
 * surrounding space, and then by a prefix that only one item has, so
 * the caller can name an item without copying all of it. When more
 * than one item fits, nothing changes and the candidates are named,
 * since ticking the wrong one is worse than asking.
 */
export function setCheckbox(
	body: string,
	item: string,
	done: boolean,
): EditApplied | EditRefused {
	const wanted = normalise(item);
	if (!wanted) return { ok: false, reason: "Name the item to tick." };
	const lines = body.split("\n");
	const items = checkboxLines(lines);
	if (items.length === 0) {
		return { ok: false, reason: "The document has no checkbox items." };
	}
	const found = findItem(items, item);
	if (!found.ok) return found;
	const { match } = found;
	const parts = CHECKBOX.exec(lines[match.index]);
	if (!parts) return { ok: false, reason: "The item could not be read." };
	const mark = done ? "x" : " ";
	const wasDone = parts[2] !== " ";
	if (wasDone === done) {
		return { ok: true, body, changed: false, line: lines[match.index] };
	}
	lines[match.index] = `${parts[1]}${mark}${parts[3]}${parts[4]}`;
	return {
		ok: true,
		body: lines.join("\n"),
		changed: true,
		line: lines[match.index],
	};
}

/** An item's text without the number it is listed by, as `7. `. */
const ITEM_NUMBER = /^\d+[a-z]?[.)]\s+/;

/**
 * The one item a caller names: by its exact text, else by a start only
 * one item has, read with or without the number in front of it, so
 * `Write the` finds `7. Write the tests`. A bare number names the item
 * it numbers, so `7` finds `7. Write the tests` and not `70. ...`.
 */
function findItem(
	items: readonly Located[],
	item: string,
): { ok: true; match: Located } | EditRefused {
	const wanted = normalise(item);
	const readings = (i: Located) => {
		const text = normalise(i.text);
		return [text, text.replace(ITEM_NUMBER, "")];
	};
	const exact = items.filter((i) => readings(i).includes(wanted));
	const prefixed = items.filter((i) =>
		readings(i).some((text) => text.startsWith(wanted)),
	);
	// A number names only the item it numbers, never one starting `12:00`.
	const matches = /^\d+$/.test(wanted)
		? items.filter((i) =>
				new RegExp(`^${wanted}[.):]?(\\s|$)`).test(normalise(i.text)),
			)
		: exact.length > 0
			? exact
			: prefixed;
	if (matches.length === 0) {
		return {
			ok: false,
			reason: `No item reads "${item.trim()}". The items are:\n${listItems(items)}`,
		};
	}
	if (matches.length > 1) {
		return {
			ok: false,
			reason: `${matches.length} items fit "${item.trim()}"; name more of the one meant:\n${listItems(matches)}`,
		};
	}
	return { ok: true, match: matches[0] };
}

/** One checkbox item, as an outline lists it. */
export interface OutlineItem {
	/**
	 * Its text without the checkbox, with its paragraph's further lines
	 * joined to it, so an item written over several lines reads whole. A
	 * deeper line with no blank before it is that paragraph in markdown,
	 * so a note written that way joins too; a note after a blank line, or
	 * a list line, does not.
	 */
	readonly text: string;
	readonly done: boolean;
	/** How far it is nested: 0 for a top-level item. */
	readonly depth: number;
}

/** One `##` section, as an outline lists it. */
export interface OutlineSection {
	readonly heading: string;
	/** Its size in bytes, heading included. */
	readonly bytes: number;
}

/** What a document holds, without its prose. */
export interface Outline {
	readonly sections: readonly OutlineSection[];
	readonly items: readonly OutlineItem[];
}

/** A document's sections with their sizes, and its checkbox items. */
export function outlineOf(body: string): Outline {
	const lines = body.split("\n");
	const headings = secondLevelHeadings(lines);
	const sections = headings.map((h, at) => ({
		heading: h.text,
		bytes: Buffer.byteLength(
			lines.slice(h.index, headings[at + 1]?.index ?? lines.length).join("\n"),
		),
	}));
	const items = checkboxLines(lines).map((i) => {
		const parts = CHECKBOX.exec(lines[i.index]);
		const indent = parts?.[1].match(/^\s*/)?.[0].replace(/\t/g, "  ").length;
		const wrapped: string[] = [i.text];
		for (const line of lines.slice(i.index + 1)) {
			if (!line.trim() || indentOf(line) <= (indent ?? 0)) break;
			if (/^\s*([-*+]|\d+[.)])\s/.test(line)) break;
			wrapped.push(line.trim());
		}
		return {
			text: wrapped.join(" "),
			done: parts?.[2] !== " ",
			depth: Math.floor((indent ?? 0) / 2),
		};
	});
	return { sections, items };
}

/** A read that found what it was asked for. */
export interface ReadFound {
	ok: true;
	/** The heading or item line it found, as written. */
	found: string;
	/** What sits under it. */
	text: string;
}

/**
 * What sits under a `##` heading, up to the next one, matched as
 * `replaceSection` matches it.
 */
export function sectionOf(
	body: string,
	heading: string,
): ReadFound | EditRefused {
	const wanted = headingWords(heading);
	if (!wanted) return { ok: false, reason: "Name the section to read." };
	const lines = body.split("\n");
	const headings = secondLevelHeadings(lines);
	const at = headings.findIndex((h) => headingWords(h.text) === wanted);
	if (at === -1) {
		const known = headings.map((h) => h.text).join(", ");
		return {
			ok: false,
			reason: `No section is headed "${heading.trim()}".${known ? ` The sections are: ${known}.` : ""}`,
		};
	}
	const end = headings[at + 1]?.index ?? lines.length;
	const text = trimBlankEdges(lines.slice(headings[at].index + 1, end));
	return { ok: true, found: headings[at].text, text: text.join("\n") };
}

/**
 * One checkbox item with its notes: the lines under it nested deeper,
 * up to the next line at its depth or a heading. Matched as
 * `setCheckbox` matches it.
 */
export function itemOf(body: string, item: string): ReadFound | EditRefused {
	if (!normalise(item)) return { ok: false, reason: "Name the item to read." };
	const lines = body.split("\n");
	const items = checkboxLines(lines);
	if (items.length === 0) {
		return { ok: false, reason: "The document has no checkbox items." };
	}
	const found = findItem(items, item);
	if (!found.ok) return found;
	const at = found.match.index;
	const depth = indentOf(lines[at]);
	let end = at + 1;
	while (end < lines.length) {
		const line = lines[end];
		if (/^#{1,6}\s/.test(line)) break;
		if (line.trim() !== "" && indentOf(line) <= depth) break;
		end++;
	}
	const notes = trimBlankEdges(lines.slice(at + 1, end));
	return { ok: true, found: lines[at].trim(), text: notes.join("\n") };
}

function indentOf(line: string): number {
	return (line.match(/^\s*/)?.[0] ?? "").replace(/\t/g, "  ").length;
}

/** Sections that belong to a verb of their own and are never replaced. */
const PROTECTED_SECTIONS: ReadonlySet<string> = new Set(["journey"]);

/**
 * A README's sections, in the quest format's order and with its
 * glyphs (quest-format's Body Sections); the optional ones are added
 * when there is something to say.
 */
const README_SECTIONS: readonly {
	readonly heading: string;
	readonly optional: boolean;
}[] = [
	{ heading: "📜 Summary", optional: false },
	{ heading: "🧭 Purpose", optional: false },
	{ heading: "🎭 Cast", optional: false },
	{ heading: "🌄 Journey", optional: false },
	{ heading: "🎯 Milestones", optional: true },
	{ heading: "🔥 Spirit", optional: true },
	{ heading: "🏆 Outcomes", optional: true },
	{ heading: "🏰 Context", optional: true },
];

/**
 * What to do with a heading the document does not have: refuse it,
 * add it at the end (a plan or research document grows the sections
 * its work needs), or, in a README, add one of the format's optional
 * sections in its place.
 */
export type MissingSection = "refuse" | "append" | "readme";

/**
 * Replace what sits under a named second-level heading, up to the
 * next one.
 *
 * The heading is matched by its words, ignoring case and any emoji in
 * front, so `Purpose` finds `## 🎯 Purpose`. The new text may not hold
 * a heading of its own level, which would split the section in two
 * and leave the document with a shape nobody asked for. Journey is
 * append-only, and has `journal` for that.
 *
 * A heading the document does not have is added at its end under
 * `append`: a plan or research document grows the sections its work
 * needs ("Kept Outcomes", "People Waiting on Us"), and refusing those
 * sent agents to hand edits the lock exists to replace. A README's
 * sections are a closed set the quest format names, so under `readme`
 * only its optional sections are added, each in its place in the
 * order and with its glyph, and any other heading is refused.
 */
export function replaceSection(
	body: string,
	heading: string,
	text: string,
	missing: MissingSection = "refuse",
): EditApplied | EditRefused {
	const wanted = headingWords(heading);
	if (!wanted) return { ok: false, reason: "Name the section to replace." };
	if (PROTECTED_SECTIONS.has(wanted)) {
		return {
			ok: false,
			reason:
				"Journey is append-only: add to it with `journal` rather than rewriting it.",
		};
	}
	if (secondLevelHeadings(text.split("\n")).length > 0) {
		return {
			ok: false,
			reason:
				"The new text holds a `## ` heading, which would split the section; give only its body.",
		};
	}
	const lines = body.split("\n");
	const headings = secondLevelHeadings(lines);
	const at = headings.findIndex((h) => headingWords(h.text) === wanted);
	if (at === -1 && missing === "append") {
		const title = heading.trim().replace(/^#+\s*/, "");
		return {
			ok: true,
			body: appended(body, title, text),
			changed: true,
			added: true,
		};
	}
	const place = README_SECTIONS.findIndex(
		(one) => headingWords(one.heading) === wanted,
	);
	if (at === -1 && missing === "readme" && README_SECTIONS[place]?.optional) {
		const after = headings.find(
			(h) =>
				README_SECTIONS.findIndex(
					(one) => headingWords(one.heading) === headingWords(h.text),
				) > place,
		);
		const title = README_SECTIONS[place].heading;
		const result = after
			? [
					...lines.slice(0, after.index),
					`## ${title}`,
					"",
					...trimBlankEdges(text.split("\n")),
					"",
					...lines.slice(after.index),
				].join("\n")
			: appended(body, title, text);
		return { ok: true, body: result, changed: true, added: true };
	}
	if (at === -1) {
		const known = headings.map((h) => h.text).join(", ");
		const addable =
			missing === "readme"
				? ` A README gains only ${README_SECTIONS.filter((one) => one.optional)
						.map((one) =>
							headingWords(one.heading).replace(/^./, (c) => c.toUpperCase()),
						)
						.join(", ")}.`
				: "";
		return {
			ok: false,
			reason: `No section is headed "${heading.trim()}".${known ? ` The sections are: ${known}.` : ""}${addable}`,
		};
	}
	const start = headings[at].index + 1;
	const end = headings[at + 1]?.index ?? lines.length;
	// A blank line before the next heading, or the file's final newline.
	const trailing = end < lines.length || body.endsWith("\n") ? [""] : [];
	const replacement = ["", ...trimBlankEdges(text.split("\n")), ...trailing];
	const next = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
	const result = next.join("\n");
	return { ok: true, body: result, changed: result !== body };
}

/** The body with a section added at its end. */
function appended(body: string, title: string, text: string): string {
	const kept = body.replace(/\s*$/, "");
	const section = trimBlankEdges(text.split("\n")).join("\n");
	return `${kept}${kept ? "\n\n" : ""}## ${title}\n\n${section}\n`;
}

/** Lowercase and collapse space, so a match ignores how it was typed. */
function normalise(text: string): string {
	return plain(text).trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Text as it reads, without the markdown that dresses it: a link's
 * words without its target, and no bold, strike or code marks. Plans
 * lead items with a bold label (`**R5. m569: restart leafd.**`), and
 * agents name the item by the words they see, so matching on the
 * marks refused them. Both sides go through this, so a `*` in a glob
 * or a `__` in a name still compares equal to itself.
 */
function plain(text: string): string {
	return text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\*\*|__|~~|`/g, "")
		.replace(/(^|\s)\*(\S)/g, "$1$2")
		.replace(/(\S)\*(?=\s|$)/g, "$1");
}

/** A heading's words, without the emoji the quest format puts first. */
function headingWords(heading: string): string {
	return normalise(
		heading.replace(/^#+\s*/, "").replace(/^[^\p{L}\p{N}]+/u, ""),
	);
}

interface Located {
	index: number;
	text: string;
}

/** Checkbox lines outside fenced code, with their item text. */
function checkboxLines(lines: readonly string[]): Located[] {
	return outsideFences(lines).flatMap((index) => {
		const parts = CHECKBOX.exec(lines[index]);
		return parts ? [{ index, text: parts[4] }] : [];
	});
}

/** Second-level headings outside fenced code. */
function secondLevelHeadings(lines: readonly string[]): Located[] {
	return outsideFences(lines).flatMap((index) =>
		/^##\s/.test(lines[index])
			? [{ index, text: lines[index].replace(/^##\s+/, "").trim() }]
			: [],
	);
}

/** Indices of the lines not inside a fenced code block. */
function outsideFences(lines: readonly string[]): number[] {
	const indices: number[] = [];
	let fenced = false;
	for (const [index, line] of lines.entries()) {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (!fenced) indices.push(index);
	}
	return indices;
}

/** How many candidates a refusal names; a plan can hold hundreds. */
const LISTED_ITEMS = 20;

function listItems(items: readonly Located[]): string {
	const listed = items.slice(0, LISTED_ITEMS).map((i) => `- ${i.text}`);
	const more = items.length - listed.length;
	if (more > 0) {
		listed.push(
			`- and ${more} more; \`show\` with the document's id lists the open ones.`,
		);
	}
	return listed.join("\n");
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start++;
	while (end > start && lines[end - 1].trim() === "") end--;
	return lines.slice(start, end);
}
