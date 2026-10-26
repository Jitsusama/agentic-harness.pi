/**
 * Whether a name says the glossary's words or a name it replaces.
 *
 * core.nix keeps the glossary, docs/glossary.md: every thing its machines and their
 * tooling hold, its one word in each context, and the names that word replaces. Two names
 * for one thing cost a reader every time they meet them, so a replaced name is never
 * written, shown or found. Each repository holds its own names to
 * it; this is the matcher they share, read as core's tests/names.py reads it, so a name
 * passes or fails the same way in every one.
 *
 * A name is split into words at underscores, hyphens, dots, spaces and capitals, and a
 * plural counts as its word. A replaced name inside a longer term passes ("line" inside
 * "status line"), and so does one the row replacing it spells on its own as its code's
 * (`pressure` for filling). Another row's code doesn't count: the `backlight` program is a
 * screen's brightness, so backlight for the keyboard's light still fails. Most replaced names are ordinary English, so each repository
 * keeps the names that use one in another sense, or wait on a rename, and a kept name it
 * no longer has fails, so what's kept only shrinks.
 */

/** One row of the glossary: its word, the names it replaces, and how code spells it. */
export interface Thing {
	word: string;
	replaces: string[];
	code: string;
}

/** Every row of the glossary's word tables, in any context. */
export function readGlossary(text: string): Thing[] {
	const things: Thing[] = [];
	let columns: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.trimStart().startsWith("|")) {
			columns = [];
			continue;
		}
		const cells = line
			.trim()
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((cell) => cell.trim());
		if (cells.join("").replace(/[-: ]/g, "") === "") continue;
		if (columns.length === 0) {
			columns = cells;
			continue;
		}
		if (columns[0] !== "Word" || cells.length !== columns.length) continue;
		const at = (name: string) => cells[columns.indexOf(name)] ?? "";
		things.push({
			word: at("Word").toLowerCase(),
			replaces: at("Not")
				.split(",")
				.map((word) => word.trim().toLowerCase())
				.filter((word) => word !== ""),
			code: at("In code"),
		});
	}
	return things;
}

/** A name or a term split into its words, in lower case. */
function tokens(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9']+/)
		.filter((word) => word !== "");
}

/** Whether words say old, a plural counting as its word. */
function same(words: string[], old: string[]): boolean {
	return (
		words.length === old.length &&
		words.every((word, at) =>
			[old[at], `${old[at]}s`, `${old[at]}es`].includes(word),
		)
	);
}

/** Whether a longer term covers the words from start, as status line covers line. */
function held(
	words: string[],
	start: number,
	length: number,
	terms: string[][],
): boolean {
	return terms.some((term) => {
		if (term.length <= length) return false;
		for (
			let at = Math.max(0, start + length - term.length);
			at <= start;
			at++
		) {
			if (same(words.slice(at, at + term.length), term)) return true;
		}
		return false;
	});
}

/** Each name the glossary replaces that a name says, with the word that replaces it. */
function replaced(name: string, things: Thing[]): string[] {
	const words = tokens(name);
	const terms = things.map((thing) => tokens(thing.word));
	const out: string[] = [];
	for (const thing of things) {
		// Only the row's own code: another row's program can share the word in
		// another sense, and its names are kept as such where they're used.
		const code = [...thing.code.matchAll(/`([^`]+)`/g)].map(([, span]) =>
			tokens(span),
		);
		for (const old of thing.replaces) {
			const oldWords = tokens(old);
			if (code.some((span) => same(span, oldWords))) continue;
			for (let start = 0; start + oldWords.length <= words.length; start++) {
				if (!same(words.slice(start, start + oldWords.length), oldWords))
					continue;
				if (!held(words, start, oldWords.length, terms)) {
					out.push(
						`"${name}" says "${old}", which the glossary calls "${thing.word}".`,
					);
				}
			}
		}
	}
	return out;
}

/**
 * Each name that says a replaced name, and each kept name no longer found, as a line to
 * print; none when every name says the glossary's words.
 */
export function drift(
	things: Thing[],
	names: string[],
	kept: Iterable<string>,
): string[] {
	const keeping = new Set(kept);
	const out = names
		.filter((name) => !keeping.has(name))
		.flatMap((name) => replaced(name, things));
	for (const name of keeping) {
		if (!names.includes(name)) {
			out.push(`"${name}" is kept but no longer found: take it off.`);
		}
	}
	return out;
}
