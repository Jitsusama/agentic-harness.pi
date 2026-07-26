/**
 * Tool renderers must not pad what pi already padded.
 *
 * Pi wraps every tool row in a Box that supplies the padding, and
 * `Text` defaults to one column and one row of its own. A
 * renderer that takes the default therefore pads the same content
 * twice, putting a blank line above and below every call and
 * every result. On a transcript of one-line tool summaries the
 * screen ends up mostly empty, which is how this was found: not
 * by a test, but by a person screenshotting their terminal and
 * asking why there was so much space.
 *
 * Pi's own rendering guidance says to build Text with (0, 0).
 * That is a mechanical rule, so it is checked mechanically rather
 * than left to review. The scan reads source instead of rendering
 * a component because padding is constructor state that no public
 * API on Text reports back.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["extensions", "lib"];

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "node_modules" ? [] : sourceFiles(full);
		}
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

/** The argument list of one call, from the character after its `(`. */
function argumentList(
	source: string,
	open: number,
): { text: string; end: number } {
	let depth = 0;
	let text = "";
	let index = open;
	for (; index < source.length; index++) {
		const char = source[index];
		if (char === "(") depth++;
		else if (char === ")") {
			depth--;
			if (depth === 0) break;
		}
		text += char;
	}
	return { text: text.slice(1), end: index };
}

/**
 * Split on commas that belong to this call, ignoring commas
 * inside nested calls, literals and template strings. A naive
 * split reports `theme.fg("dim", head)` as two arguments and so
 * reads a padding-less call as correctly padded.
 */
function topLevelArguments(list: string): string[] {
	const parts: string[] = [""];
	let depth = 0;
	let quote: string | null = null;
	for (const char of list) {
		if (quote) {
			parts[parts.length - 1] += char;
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			parts[parts.length - 1] += char;
			continue;
		}
		if ("([{".includes(char)) depth++;
		if (")]}".includes(char)) depth--;
		if (char === "," && depth === 0) {
			parts.push("");
			continue;
		}
		parts[parts.length - 1] += char;
	}
	return parts.map((part) => part.trim());
}

/**
 * Report `label:line` for every `new Text(...)` in this source
 * that does not pass (0, 0).
 *
 * Takes source rather than a path so the scanner can be exercised
 * against known-good and known-bad snippets below. Proving a
 * guard works by temporarily breaking real code would leave the
 * repository one interrupted run away from a committed defect.
 */
function unpaddedTextCallsIn(source: string, label: string): string[] {
	const found: string[] = [];
	let cursor = 0;
	while (true) {
		const at = source.indexOf("new Text(", cursor);
		if (at === -1) break;
		const { text, end } = argumentList(source, at + "new Text".length);
		const args = topLevelArguments(text);
		const line = source.slice(0, at).split("\n").length;
		// A doc comment may legitimately quote a padded call while
		// describing it, so skip anything inside a comment.
		const lineText = source.split("\n")[line - 1] ?? "";
		const commented = /^\s*(\*|\/\/)/.test(lineText);
		if (!commented && (args[1] !== "0" || args[2] !== "0")) {
			found.push(`${label}:${line}`);
		}
		cursor = end;
	}
	return found;
}

function unpaddedTextCalls(file: string): string[] {
	return unpaddedTextCallsIn(readFileSync(file, "utf8"), file);
}

describe("the padding scan itself", () => {
	it("flags a Text built with no padding arguments", () => {
		expect(unpaddedTextCallsIn("return new Text(line);", "f.ts")).toEqual([
			"f.ts:1",
		]);
	});

	it("accepts a Text built with (0, 0)", () => {
		expect(unpaddedTextCallsIn("return new Text(line, 0, 0);", "f.ts")).toEqual(
			[],
		);
	});

	it("does not read a nested call's comma as the padding argument", () => {
		// The reason this scanner parses instead of splitting on
		// commas: `theme.fg("dim", head)` looks like two arguments to
		// a naive split, which would read an unpadded call as padded
		// and pass the very case that started this.
		expect(
			unpaddedTextCallsIn('new Text(theme.fg("dim", head));', "f.ts"),
		).toEqual(["f.ts:1"]);
	});

	it("is not fooled by a comma inside a string or template", () => {
		expect(unpaddedTextCallsIn('new Text("a, b", 0, 0);', "f.ts")).toEqual([]);
		expect(
			unpaddedTextCallsIn(`new Text(\`a, \${b}\`, 0, 0);`, "f.ts"),
		).toEqual([]);
	});

	it("flags a padded x but defaulted y, which still adds blank lines", () => {
		expect(unpaddedTextCallsIn("new Text(line, 1, 0);", "f.ts")).toEqual([
			"f.ts:1",
		]);
	});

	it("ignores a call quoted inside a doc comment", () => {
		expect(
			unpaddedTextCallsIn(" * Pi renders via new Text(line, 1, 0),", "f.ts"),
		).toEqual([]);
	});

	it("reports the line each offender sits on", () => {
		const source = ["ok();", "new Text(a, 0, 0);", "new Text(b);"].join("\n");
		expect(unpaddedTextCallsIn(source, "f.ts")).toEqual(["f.ts:3"]);
	});
});

describe("tool renderers do not double-pad their output", () => {
	it("builds every Text with padding (0, 0)", () => {
		const offenders = ROOTS.filter((root) => {
			try {
				return statSync(root).isDirectory();
			} catch {
				// A consumer checkout may not carry both roots; an
				// absent one has nothing to check rather than failing.
				return false;
			}
		})
			.flatMap(sourceFiles)
			.flatMap(unpaddedTextCalls);

		expect(offenders).toEqual([]);
	});
});
