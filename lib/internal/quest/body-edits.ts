/**
 * Edits to the body of a quest document that leave its front matter
 * byte for byte as it was: ticking a checkbox, replacing a section.
 *
 * Pure text in, text out. The verbs that call these hold the quest
 * lock around the read and the write, which is the point of having
 * verbs at all: a hand edit read the file, the workflow rewrote it
 * underneath, and the edit then missed its anchor.
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
	const exact = items.filter((i) => normalise(i.text) === wanted);
	const prefixed = items.filter((i) => normalise(i.text).startsWith(wanted));
	const matches = exact.length > 0 ? exact : prefixed;
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
	const [match] = matches;
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

/** Sections that belong to a verb of their own and are never replaced. */
const PROTECTED_SECTIONS: ReadonlySet<string> = new Set(["journey"]);

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
 * A heading the document does not have is added at its end when
 * `addMissing` is set. A README's sections are a closed set the
 * quest format names, so it refuses there; a plan or research
 * document grows the sections its work needs ("Kept Outcomes",
 * "People Waiting on Us"), and refusing those sent agents to hand
 * edits the lock exists to replace.
 */
export function replaceSection(
	body: string,
	heading: string,
	text: string,
	addMissing = false,
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
	if (at === -1 && addMissing) {
		const kept = body.replace(/\s*$/, "");
		const title = heading.trim().replace(/^#+\s*/, "");
		const section = trimBlankEdges(text.split("\n")).join("\n");
		const result = `${kept}${kept ? "\n\n" : ""}## ${title}\n\n${section}\n`;
		return { ok: true, body: result, changed: true, added: true };
	}
	if (at === -1) {
		const known = headings.map((h) => h.text).join(", ");
		return {
			ok: false,
			reason: `No section is headed "${heading.trim()}".${known ? ` The sections are: ${known}.` : ""}`,
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

function listItems(items: readonly Located[]): string {
	return items.map((i) => `- ${i.text}`).join("\n");
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start++;
	while (end > start && lines[end - 1].trim() === "") end--;
	return lines.slice(start, end);
}
