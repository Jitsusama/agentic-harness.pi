/**
 * A module's JavaScript with its comments taken out wherever nothing
 * follows them on their line, for the stripped-source cache to keep.
 *
 * V8 holds every module's source for as long as the module lives, so
 * that a function can be compiled again and its text read back. A
 * comment costs that memory and nothing else: the package's own 1808
 * modules, once node strips their types, are 13.35 million characters
 * with their comments and 7.07 million without, and a process importing
 * every extension through the cache settled at 52.5 MB of heap without
 * them against 57.3 MB with them.
 *
 * Each line keeps its number and every piece of code its column, so a
 * stack trace reads as it did: a line comment goes, and so does a block
 * comment with nothing after it on its line, leaving its line ends; one
 * with code after it stays. The spaces a line ends with go too, which
 * is where node's strip leaves a type it took off the end of a line or
 * a whole interface. A comment's own text is gone from what a function's
 * `toString` reads, which is all that changes. A `//#` or `//@` comment
 * stays, since node reads a source's URL from one.
 *
 * The reading tells a regular expression from a division by what came
 * before the slash, as a parser would without the grammar. Where it
 * can't close a string, template, pattern or comment on the line a
 * parser would, or a module holds a line separator, the module is kept
 * as it was given. A test reads every module of this package both ways
 * and asks that each token stands where it stood.
 *
 * Plain `.mjs`, as stripped-source.mjs is, since it runs before node
 * loads any of this package's TypeScript.
 */

/** Words after which a slash opens a regular expression rather than dividing. */
const BEFORE_EXPRESSION = new Set([
	"await",
	"case",
	"default",
	"delete",
	"do",
	"else",
	"extends",
	"in",
	"instanceof",
	"new",
	"of",
	"return",
	"throw",
	"typeof",
	"void",
	"yield",
]);

/** Words whose parenthesis holds a condition, after which a slash opens a regular expression. */
const CONDITIONS = new Set(["for", "if", "while", "with"]);

/** A line separator or paragraph separator, which ends a line comment as a newline does. */
const SEPARATORS = /[\u2028\u2029]/;

/** Any whitespace but space, tab and the line ends, to tell it from a word's letters. */
const OTHER_SPACE = /\s/;

/**
 * `source` with each comment that nothing follows on its line taken
 * out, and each line's closing spaces, or `source` itself where its
 * reading is in doubt.
 *
 * @param {string} source a module's JavaScript, as node's strip gives it
 * @returns {string}
 */
export function withoutComments(source) {
	if (SEPARATORS.test(source)) return source;
	try {
		const bare = strip(source);
		return lineEnds(bare) === lineEnds(source) ? bare : source;
	} catch {
		// Something this reading can't close where a parser would: the
		// module is kept as node stripped it.
		return source;
	}
}

/**
 * How many newlines `text` holds.
 *
 * @param {string} text
 * @returns {number}
 */
function lineEnds(text) {
	let count = 0;
	for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1))
		count++;
	return count;
}

/**
 * Whether `code` is a character code ending a line.
 *
 * @param {number} code
 * @returns {boolean}
 */
function endsLine(code) {
	return code === 10 || code === 13;
}

/**
 * Whether the character at `at` in `src` belongs to a name, a keyword
 * or a number.
 *
 * @param {string} src
 * @param {number} at
 * @returns {boolean}
 */
function wordAt(src, at) {
	const code = src.charCodeAt(at);
	if (code > 127) return !OTHER_SPACE.test(src[at] ?? "");
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		code === 95 || // _
		code === 36 || // $
		code === 35 || // # of a private name
		code === 92 // \ of an escaped letter
	);
}

/**
 * Where the line holding `at` ends in `src`: its newline or carriage
 * return, or the end of the text.
 *
 * @param {string} src
 * @param {number} at
 * @returns {number}
 */
function lineEndFrom(src, at) {
	let end = at;
	while (end < src.length && !endsLine(src.charCodeAt(end))) end++;
	return end;
}

/**
 * `src` with its comments and closing spaces taken out, throwing where
 * a string, template, pattern or comment doesn't close as it must.
 *
 * @param {string} src
 * @returns {string}
 */
function strip(src) {
	const n = src.length;
	/** @type {string[]} */
	const parts = [];
	// Where the text not yet copied begins.
	let from = 0;
	let i = src.startsWith("#!") ? lineEndFrom(src, 0) : 0;
	// Whether a slash here divides, rather than opening a pattern.
	let slashDivides = false;
	// Whether the last token was a dot, making a word after it a property.
	let afterDot = false;
	// Whether the last token was a word whose parenthesis holds a condition.
	let afterCondition = false;
	/** For each open parenthesis, whether it holds a condition. @type {boolean[]} */
	const parens = [];
	/** The brace depth at which each open template's `${` was opened. @type {number[]} */
	const templates = [];
	let depth = 0;
	// Where the spaces before what comes next began in code, or -1.
	let spacesFrom = -1;

	/** Leave out `src` from `start` to `end`, putting `instead` there. */
	const cut = (
		/** @type {number} */ start,
		/** @type {number} */ end,
		instead = "",
	) => {
		parts.push(src.slice(from, start));
		if (instead) parts.push(instead);
		from = end;
	};
	/** A token has been read: spaces before it stay, and so does a pending condition only if it says so. */
	const token = (/** @type {boolean} */ divides, condition = false) => {
		slashDivides = divides;
		afterCondition = condition;
		afterDot = false;
		spacesFrom = -1;
	};
	/** Read a template's text from `i`, to its close or its next `${`. */
	const template = () => {
		let j = i;
		for (;;) {
			if (j >= n) throw new Error("unclosed template");
			const c = src.charCodeAt(j);
			if (c === 92) {
				j += 2;
			} else if (c === 96) {
				i = j + 1;
				token(true);
				return;
			} else if (c === 36 && src.charCodeAt(j + 1) === 123) {
				templates.push(depth);
				depth++;
				i = j + 2;
				token(false);
				return;
			} else {
				j++;
			}
		}
	};

	while (i < n) {
		const c = src.charCodeAt(i);
		const next = src.charCodeAt(i + 1);
		if (c === 32 || c === 9) {
			if (spacesFrom < 0) spacesFrom = i;
			i++;
		} else if (endsLine(c)) {
			if (spacesFrom >= 0) cut(spacesFrom, i);
			spacesFrom = -1;
			i++;
		} else if (c === 47 && next === 47) {
			const end = lineEndFrom(src, i);
			const third = src[i + 2];
			if (third === "#" || third === "@") {
				spacesFrom = -1;
			} else {
				cut(spacesFrom >= 0 ? spacesFrom : i, end);
				spacesFrom = -1;
			}
			i = end;
		} else if (c === 47 && next === 42) {
			const close = src.indexOf("*/", i + 2);
			if (close < 0) throw new Error("unclosed block comment");
			const after = close + 2;
			let k = after;
			while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9))
				k++;
			if (k >= n || endsLine(src.charCodeAt(k))) {
				const ends = src.slice(i, after).replace(/[^\r\n]/g, "");
				cut(spacesFrom >= 0 ? spacesFrom : i, after, ends);
			}
			spacesFrom = -1;
			i = after;
		} else if (c === 39 || c === 34) {
			let j = i + 1;
			for (;;) {
				if (j >= n) throw new Error("unclosed string");
				const s = src.charCodeAt(j);
				if (s === c) break;
				if (endsLine(s)) throw new Error("string across a line");
				if (s === 92) {
					const crlf =
						src.charCodeAt(j + 1) === 13 && src.charCodeAt(j + 2) === 10;
					j += crlf ? 3 : 2;
				} else {
					j++;
				}
			}
			i = j + 1;
			token(true);
		} else if (c === 96) {
			i++;
			spacesFrom = -1;
			template();
		} else if (c === 47 && !slashDivides) {
			let j = i + 1;
			let inClass = false;
			for (;;) {
				if (j >= n) throw new Error("unclosed pattern");
				const r = src.charCodeAt(j);
				if (endsLine(r)) throw new Error("pattern across a line");
				if (r === 92) {
					if (endsLine(src.charCodeAt(j + 1)))
						throw new Error("pattern across a line");
					j += 2;
					continue;
				}
				if (inClass) {
					if (r === 93) inClass = false;
				} else if (r === 91) {
					inClass = true;
				} else if (r === 47) {
					break;
				}
				j++;
			}
			j++;
			while (j < n && /[A-Za-z]/.test(src[j] ?? "")) j++;
			i = j;
			token(true);
		} else if (wordAt(src, i)) {
			let j = i + 1;
			while (j < n && wordAt(src, j)) j++;
			const word = src.slice(i, j);
			const property = afterDot;
			i = j;
			token(
				property || !BEFORE_EXPRESSION.has(word),
				!property && CONDITIONS.has(word),
			);
		} else if (c === 40) {
			parens.push(afterCondition);
			i++;
			token(false);
		} else if (c === 41) {
			const condition = parens.pop() ?? false;
			i++;
			token(!condition);
		} else if (c === 93) {
			i++;
			token(true);
		} else if (c === 123) {
			depth++;
			i++;
			token(false);
		} else if (c === 125) {
			i++;
			if (templates.length > 0 && templates.at(-1) === depth - 1) {
				templates.pop();
				depth--;
				spacesFrom = -1;
				template();
			} else {
				depth--;
				token(false);
			}
		} else if ((c === 43 || c === 45) && next === c) {
			i += 2;
			token(true);
		} else if (c === 46) {
			i++;
			token(false);
			afterDot = true;
		} else if (c > 127 || c === 11 || c === 12) {
			// Whitespace past ASCII or a vertical tab or form feed: kept as
			// it is, changing nothing about what a slash after it means.
			spacesFrom = -1;
			i++;
		} else {
			i++;
			token(false);
		}
	}
	if (spacesFrom >= 0) cut(spacesFrom, n);
	parts.push(src.slice(from));
	return parts.join("");
}
