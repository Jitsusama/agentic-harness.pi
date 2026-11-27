/**
 * What the stripped-source cache keeps of a module once node has
 * stripped its types: its comments out wherever nothing follows them on
 * their line, with every line and every piece of code where it stood,
 * and the module as it was wherever the reading is in doubt. The last
 * case reads every module of this package both ways.
 */

import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { withoutComments } from "../../../lib/internal/stripped-source-comments.mjs";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The folders whose modules a host or a supervisor loads through the cache. */
const SERVED = ["extensions", "host", "lib", "packs", "scripts"];

/** The lines of `text`, joined from a list so each case reads as the module does. */
const lines = (...each: string[]): string => each.join("\n");

describe("withoutComments", () => {
	it("takes out line comments and the spaces lines end with, keeping each line", () => {
		const source = lines(
			"// what this does",
			"const a = 1; // one",
			"const b = 2;   ",
			"\t// indented",
			"export { a, b };",
		);

		expect(withoutComments(source)).toBe(
			lines("", "const a = 1;", "const b = 2;", "", "export { a, b };"),
		);
	});

	it("takes out a block comment with nothing after it on its line, leaving its line ends", () => {
		const source = lines(
			"/**",
			" * A doc.",
			" */",
			"export function f() { /* the one */",
			"\treturn 1;",
			"}",
		);

		expect(withoutComments(source)).toBe(
			lines("", "", "", "export function f() {", "\treturn 1;", "}"),
		);
	});

	it("keeps a block comment that code follows on its line, so that code keeps its column", () => {
		const source = lines(
			"const x = /** @type {number} */ (y);",
			"/* a */ const z = 1;",
			"const w = 1; /* runs on",
			"   */ const v = 2;",
		);

		expect(withoutComments(source)).toBe(source);
	});

	it("keeps a comment node reads a source's URL or map from", () => {
		const source = lines(
			"const a = 1;",
			"//# sourceURL=file:///a.ts",
			"//@ sourceMappingURL=a.js.map",
		);

		expect(withoutComments(source)).toBe(source);
	});

	it("leaves comment marks in strings, templates and patterns as they are", () => {
		const source = lines(
			'const url = "http://example.com/*";',
			"const glob = '/* not a comment */';",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source text under test.
			"const said = `// ${url} /* ${glob} */`;",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source text under test.
			"const nested = `a ${`b ${'//'} c`} d`;",
			"const pattern = /\\/\\/[/*]+/g;",
			"const bracket = /[/]/.test(url);",
		);

		expect(withoutComments(source)).toBe(source);
	});

	it("keeps the spaces a line of a template ends with, which are its text", () => {
		const source = lines("const t = `one   ", "two\t", "`; // gone");

		expect(withoutComments(source)).toBe(
			lines("const t = `one   ", "two\t", "`;"),
		);
	});

	it("tells a division from a pattern by what came before the slash", () => {
		const source = lines(
			"const half = a / 2; // a / b",
			"const both = (a) / (b) / c; // after a parenthesis",
			"const after = i++ / 2; // after an increment",
			"const index = list[0] / 2; // after a bracket",
			"if (ok) /x\\/\\//.test(s); // after a condition",
			"const r = typeof /a/; // after a word wanting a value",
			"const p = obj.return / 2; // a property named as a word is",
		);

		expect(withoutComments(source)).toBe(
			lines(
				"const half = a / 2;",
				"const both = (a) / (b) / c;",
				"const after = i++ / 2;",
				"const index = list[0] / 2;",
				"if (ok) /x\\/\\//.test(s);",
				"const r = typeof /a/;",
				"const p = obj.return / 2;",
			),
		);
	});

	it("keeps carriage returns where a line ends with one", () => {
		const source = "const a = 1; // one\r\n/* two\r\n */\r\nconst b = 2;\r\n";

		expect(withoutComments(source)).toBe(
			"const a = 1;\r\n\r\n\r\nconst b = 2;\r\n",
		);
	});

	it("keeps a module whole where a string, template, pattern or comment doesn't close as it must", () => {
		// Each opens with a comment that would go, were the module read.
		const doubts = [
			"// c\nconst a = 1; /* never closed",
			'// c\nconst s = "never closed',
			"// c\nconst t = `never closed",
			"// c\nconst p = /never closed\n",
			"// c\nconst q = 'across\na line';",
			"// c\nconst a = 1; // a line separator\u2028ends a comment as a newline does",
		];

		for (const source of doubts)
			expect(withoutComments(source), JSON.stringify(source)).toBe(source);
	});

	it("leaves a shebang as it is", () => {
		expect(withoutComments("#!/usr/bin/env node // run\nrun(); // now")).toBe(
			"#!/usr/bin/env node // run\nrun();",
		);
	});

	it("keeps every token of this package's modules where it stood, as a parser reads them", () => {
		const modules: string[] = [];
		const walk = (folder: string): void => {
			for (const entry of readdirSync(folder, { withFileTypes: true })) {
				if (entry.name === "node_modules" || entry.name.startsWith("."))
					continue;
				const path = join(folder, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (/(?<!\.d)\.m?ts$/.test(entry.name)) modules.push(path);
			}
		};
		for (const folder of SERVED) walk(join(ROOT, folder));
		const tokens = (code: string): string[] =>
			(parse(code, { sourceType: "module", tokens: true }).tokens ?? [])
				.map((token: unknown) => tokenAt(token))
				.filter((token) => !token.startsWith("Comment"));
		const moved: string[] = [];
		const kept: string[] = [];
		let before = 0;
		let after = 0;
		for (const module of modules) {
			const stripped = stripTypeScriptTypes(readFileSync(module, "utf8"));
			const bare = withoutComments(stripped);
			before += stripped.length;
			after += bare.length;
			if (bare === stripped && /\/\/|\/\*/.test(stripped)) kept.push(module);
			if (tokens(bare).join("\n") !== tokens(stripped).join("\n"))
				moved.push(module);
		}

		expect(modules.length, "the package's modules are found").toBeGreaterThan(
			1000,
		);
		expect(moved, "modules whose code moved or changed").toEqual([]);
		expect(
			after / before,
			"the comments taken out are at least a fifth of the source",
		).toBeLessThan(0.8);
		expect(
			kept.length,
			"few modules holding a comment mark are kept whole",
		).toBeLessThan(modules.length / 50);
	}, 120_000);
});

/**
 * A token as `kind|value|line:column`, or `Comment` for a comment, which
 * names the kind of every token babel gives.
 */
function tokenAt(token: unknown): string {
	if (!isRecord(token)) return "?";
	const { type, value, loc } = token;
	const kind =
		typeof type === "string" ? type : isRecord(type) ? String(type.label) : "?";
	if (kind === "CommentLine" || kind === "CommentBlock") return "Comment";
	const start = isRecord(loc) && isRecord(loc.start) ? loc.start : {};
	return `${kind}|${String(value)}|${String(start.line)}:${String(start.column)}`;
}
