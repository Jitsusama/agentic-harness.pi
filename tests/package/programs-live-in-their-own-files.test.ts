/**
 * A program lives in a file of its own language.
 *
 * SQL, page JavaScript, GraphQL or shell written as a string inside
 * TypeScript is read by no linter and no editor, and the values spliced
 * into it are where quoting breaks. Past five lines it belongs in a
 * `.sql`, `.js`, `.graphql` or `.sh` file, read in. This is rule 5 of the
 * repo-quality-standard skill, and step 9 of Y9XISP's harness survey
 * (8 November), which counted 28 page scripts, 16 queries, 2 GraphQL
 * documents and 1 shell script in the package's source.
 *
 * The programs found before this check are listed per file and kind in
 * `embedded-programs.txt`. The list only shrinks: a file may not gain
 * one, and a file that loses one has its count lowered.
 *
 * A program is a template literal whose fixed text, the parts outside
 * its `${}`, runs past five lines that are not blank, and reads as one
 * of the four kinds. A short splice of values stays where it is.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** The folders holding the package's code. */
const SOURCES = ["extensions", "lib", "packs", "scripts", "tests"];

/** Folders that are not the package's own: tools' output and checkouts. */
const SKIPPED = new Set(["node_modules", "dist", "coverage"]);

/** The shrink-only list of files and the programs each still embeds. */
const LIST = join(import.meta.dirname, "embedded-programs.txt");

/** How many lines a splice may run before it counts as a program. */
const MOST_LINES = 5;

/** The kinds of program, each with what tells it apart, asked in order. */
const KINDS: ReadonlyArray<{ kind: string; reads: (text: string) => boolean }> =
	[
		{
			kind: "page-js",
			reads: (text) =>
				/\b(?:document|window)\.\w|querySelector|getComputedStyle|\bperformance\.\w/.test(
					text,
				),
		},
		{
			kind: "sql",
			reads: (text) =>
				/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP)\b/.test(text) &&
				/\b(?:FROM|INTO|TABLE|VIEW|INDEX|SET|WHERE)\b/.test(text),
		},
		{
			kind: "graphql",
			reads: (text) =>
				/\b(?:query|mutation)\b[^{]*\{/.test(text) &&
				/\$\w+\s*:|\bnodes\s*\{/.test(text),
		},
		{
			kind: "shell",
			reads: (text) => /^\s*(?:fi|done|esac)\s*$|^#!|\bset -e\b/m.test(text),
		},
	];

/** One template literal: the line it opens on and its fixed text. */
interface Literal {
	readonly line: number;
	readonly text: string;
}

/** What the scanner is inside: code, with its open braces, or a template. */
type Frame =
	| { readonly kind: "code"; braces: number }
	| { readonly kind: "template"; readonly line: number; text: string };

/** What a placeholder leaves in a literal's fixed text: a word, so what surrounds it still reads. */
const SPLICE = "_";

/** The characters after which a slash opens a regular expression, not a division. */
const BEFORE_REGEX = new Set([..."(,=:[!&|?{};+-*%<>~^"]);

/** The words after which a slash opens a regular expression. */
const REGEX_AFTER_WORD = /\b(?:return|typeof|case|of|in|yield|await)\s*$/;

/**
 * Every template literal in some source, with its fixed text.
 *
 * A literal inside another's `${}` is found on its own and leaves only
 * the placeholder in the outer one. Strings, comments and regular
 * expressions are stepped over, so a backtick in one opens nothing.
 */
function templateLiterals(source: string): Literal[] {
	const found: Literal[] = [];
	const stack: Frame[] = [{ kind: "code", braces: 0 }];
	let line = 1;
	let last = "";
	let at = 0;
	const step = (count = 1): void => {
		for (let i = 0; i < count; i++) {
			if (source[at] === "\n") line++;
			at++;
		}
	};
	while (at < source.length) {
		const frame = stack.at(-1);
		const char = source[at] ?? "";
		const next = source[at + 1] ?? "";
		if (frame?.kind === "template") {
			if (char === "\\") {
				frame.text += char + next;
				step(2);
			} else if (char === "`") {
				found.push({ line: frame.line, text: frame.text });
				stack.pop();
				last = "`";
				step();
			} else if (char === "$" && next === "{") {
				frame.text += SPLICE;
				stack.push({ kind: "code", braces: 0 });
				last = "{";
				step(2);
			} else {
				frame.text += char;
				step();
			}
			continue;
		}
		if (frame === undefined) break;
		if (char === "/" && next === "/") {
			while (at < source.length && source[at] !== "\n") step();
		} else if (char === "/" && next === "*") {
			step(2);
			while (at < source.length && !source.startsWith("*/", at)) step();
			step(2);
		} else if (char === "'" || char === '"') {
			step();
			while (at < source.length && source[at] !== char) {
				step(source[at] === "\\" ? 2 : 1);
			}
			step();
			last = char;
		} else if (
			char === "/" &&
			(last === "" ||
				BEFORE_REGEX.has(last) ||
				REGEX_AFTER_WORD.test(source.slice(Math.max(0, at - 8), at)))
		) {
			let inClass = false;
			step();
			while (at < source.length && source[at] !== "\n") {
				const inside = source[at];
				if (inside === "\\") {
					step(2);
					continue;
				}
				if (inside === "[") inClass = true;
				else if (inside === "]") inClass = false;
				else if (inside === "/" && !inClass) break;
				step();
			}
			step();
			last = "/";
		} else if (char === "`") {
			stack.push({ kind: "template", line, text: "" });
			step();
		} else if (char === "{") {
			frame.braces++;
			last = char;
			step();
		} else if (char === "}" && frame.braces === 0 && stack.length > 1) {
			stack.pop();
			step();
		} else {
			if (char === "}") frame.braces--;
			if (!/\s/.test(char)) last = char;
			step();
		}
	}
	return found;
}

/** The programs embedded in some source, by kind. */
function embeddedPrograms(source: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const { text } of templateLiterals(source)) {
		const lines = text.split("\n").filter((each) => each.trim() !== "");
		if (lines.length <= MOST_LINES) continue;
		const kind = KINDS.find((each) => each.reads(text))?.kind;
		if (kind !== undefined) counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	return counts;
}

function sourcesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith(".") || SKIPPED.has(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...sourcesUnder(path));
		else if (/\.m?ts$|\.mjs$/.test(entry)) found.push(relative(ROOT, path));
	}
	return found;
}

/** Each file's embedded programs, keyed by the file and the kind. */
function counted(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const file of SOURCES.flatMap((dir) => sourcesUnder(join(ROOT, dir)))) {
		// This file's own examples are programs on purpose.
		if (file === relative(ROOT, import.meta.filename)) continue;
		const source = readFileSync(join(ROOT, file), "utf8");
		for (const [kind, count] of embeddedPrograms(source)) {
			counts.set(`${file} ${kind}`, count);
		}
	}
	return counts;
}

/** The list as it stands: each file and kind, and the count it may still have. */
function listed(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of readFileSync(LIST, "utf8").split("\n")) {
		const [file, kind, count] = line.trim().split(/\s+/);
		if (file && kind && count && !file.startsWith("#")) {
			counts.set(`${file} ${kind}`, Number(count));
		}
	}
	return counts;
}

/** A template literal of some lines, as source. */
function literal(...lines: string[]): string {
	return `const program = \`\n${lines.join("\n")}\n\`;`;
}

describe("the package's code", () => {
	it("tell a program from a splice", () => {
		// A scanner that finds nothing passes everything. This is the check
		// that it finds what it is meant to and lets the rest by.
		const query = literal(
			"SELECT session_id,",
			"\tSUM(cost) AS cost",
			"FROM turns",
			"WHERE day = ?",
			"GROUP BY session_id",
			"ORDER BY cost DESC",
		);
		expect(embeddedPrograms(query), "a six-line query is found").toEqual(
			new Map([["sql", 1]]),
		);
		expect(
			embeddedPrograms(
				literal("SELECT a", "FROM b", "WHERE c", "AND d", "ORDER BY e"),
			),
			"five lines are a splice",
		).toEqual(new Map());
		expect(
			embeddedPrograms(
				literal(
					"const rect = document.body",
					"\t.getBoundingClientRect();",
					"return {",
					"\twidth: rect.width,",
					"\theight: rect.height,",
					"};",
				),
			),
			"a script run in a page is found",
		).toEqual(new Map([["page-js", 1]]));
		expect(
			embeddedPrograms(
				literal(
					"query($owner: String!) {",
					"\trepository(owner: $owner) {",
					"\t\tissues(first: 10) {",
					"\t\t\tnodes { title }",
					"\t\t}",
					"\t}",
					"}",
				),
			),
			"a GraphQL document is found",
		).toEqual(new Map([["graphql", 1]]));
		expect(
			embeddedPrograms(
				literal(
					"#!/bin/sh",
					"set -e",
					"for f in *; do",
					'\techo "$f"',
					"done",
					"exit 0",
				),
			),
			"a shell script is found",
		).toEqual(new Map([["shell", 1]]));
		expect(
			embeddedPrograms(
				literal(
					"You are reviewing a change.",
					"Read the diff.",
					"Select the riskiest file,",
					"and say from where",
					"its inputs come.",
					"Answer in prose.",
				),
			),
			"prose is no program, whatever its words",
		).toEqual(new Map());
		expect(
			embeddedPrograms(
				`const pattern = /\`/;\n// a \` in a comment\nconst quote = "\`";\n${query}`,
			),
			"a backtick in a regular expression, a comment or a string opens nothing",
		).toEqual(new Map([["sql", 1]]));
		expect(
			embeddedPrograms(
				`const outer = \`\${inner(\`\nSELECT a\nFROM b\nWHERE c\nAND d\nAND e\nORDER BY f\n\`)}\`;`,
			),
			"a query nested in another literal's placeholder is found on its own",
		).toEqual(new Map([["sql", 1]]));
	});

	it("write each program in a file of its own language", () => {
		const now = counted();
		const before = listed();
		const grown = [...now]
			.filter(([key, count]) => count > (before.get(key) ?? 0))
			.map(
				([key, count]) => `${key}: ${count}, listed ${before.get(key) ?? 0}`,
			);
		expect(
			grown,
			`these files embed a program of more than ${MOST_LINES} lines in a string: move it to a .sql, .js, .graphql or .sh file beside the code and read it in, so a linter and an editor can read it:\n${grown.join("\n")}`,
		).toEqual([]);
	});

	it("keep the list of embedded programs no longer than what's left", () => {
		const now = counted();
		const stale = [...listed()]
			.filter(([key, count]) => count > (now.get(key) ?? 0))
			.map(([key, count]) => `${key} ${now.get(key) ?? 0} (listed ${count})`);
		expect(
			stale,
			`these files embed fewer programs than tests/package/embedded-programs.txt allows; lower each to the count given, or remove it at 0, since the list only shrinks:\n${stale.join("\n")}`,
		).toEqual([]);
	});
});
