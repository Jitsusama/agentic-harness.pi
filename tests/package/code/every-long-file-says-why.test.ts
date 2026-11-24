/**
 * Every long code file and crowded folder says why, or waits.
 *
 * A code file past 800 lines is usually several things that grew
 * together, and a folder of more than 40 entries is one a reader can't
 * scan for the thing they want. Either is split by what changes for one
 * reason, or says why it stays whole: a code file in its opening comment,
 * in a sentence beginning "Long because", and a folder in its README.md
 * or AGENTS.md, in one beginning "Many entries because". This is step 10
 * of Y9XISP's harness survey (8 November), which counted 39 files past
 * 800 lines and 88 loose files in `tests/extensions/`, and the same rule
 * core.nix holds as every-long-file-says-why.
 *
 * The files and folders past their limit before this check are listed in
 * `long-files-waiting.txt`, a path a line. The list only shrinks: one
 * that's split, says why or is gone fails until it's taken off.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCode, packageFiles } from "./package-files.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The shrink-only list of files and folders past their limit. */
const LIST = join(import.meta.dirname, "long-files-waiting.txt");

/** How long a walk of the whole tree may take on a busy machine. */
const WALK = { timeout: 60_000 };

/** The most lines a code file holds before it says why. */
const MOST_LINES = 800;

/** The most entries a folder holds before it says why. */
const MOST_ENTRIES = 40;

/** The notes a folder says why in. */
const NOTES = ["README.md", "AGENTS.md"];

/** A file's lines, the newline ending the last not making another. */
function lineCount(text: string): number {
	const newlines = text.split("\n").length - 1;
	return newlines + (text === "" || text.endsWith("\n") ? 0 : 1);
}

/**
 * The comment a file opens with, as one line of words. A shebang and
 * blank lines may come first; the comment is a run of line comments or
 * block comments, which may follow one another.
 */
function openingComment(text: string): string {
	const lines = text.split("\n");
	let at = lines[0]?.startsWith("#!") ? 1 : 0;
	const said: string[] = [];
	while (at < lines.length) {
		const line = (lines[at] ?? "").trim();
		if (line.startsWith("/*")) {
			let end = at;
			while (end < lines.length && !(lines[end] ?? "").includes("*/")) end++;
			said.push(...lines.slice(at, end + 1));
			at = end + 1;
		} else if (line.startsWith("//") || line.startsWith("#")) {
			said.push(line);
			at++;
		} else if (said.length === 0 && line === "") {
			at++;
		} else {
			break;
		}
	}
	const words = said
		.join("\n")
		.replace(/^\s*\*(?!\/)/gm, " ")
		.replace(/\/\*+|\*+\/|\/\/|#/g, " ");
	return words.split(/\s+/).filter(Boolean).join(" ");
}

/** Whether a code file's opening comment has a sentence beginning "Long because". */
function saysWhyLong(text: string): boolean {
	// Not followed by a letter or digit, as Rust's is_alphanumeric reads
	// one, not only ASCII's, which \b would.
	return /(^|[.:;!?] )Long because(?![\p{Alphabetic}\p{N}])/u.test(
		openingComment(text),
	);
}

/** Whether a folder's README.md or AGENTS.md has a sentence beginning "Many entries because". */
function saysWhyMany(folder: string): boolean {
	return NOTES.some((note) => {
		const path = join(folder, note);
		if (!existsSync(path)) return false;
		const text = readFileSync(path, "utf8").split(/\s+/).join(" ");
		return /(?<![\p{Alphabetic}\p{N}_])Many entries because(?![\p{Alphabetic}\p{N}_])/u.test(
			text,
		);
	});
}

interface Over {
	/** Files and folders past their limit that don't say why. */
	readonly unreasoned: string[];
	/** How many past their limit say why. */
	readonly reasoned: number;
}

/**
 * The package's files and folders past their limit, a folder's entries
 * being the files and folders right in it, as code-health counts them.
 */
function over(): Over {
	const files = packageFiles(ROOT).sort();
	const entries = new Map<string, Set<string>>();
	for (const file of files) {
		const parts = file.split("/");
		parts.forEach((part, depth) => {
			const folder = parts.slice(0, depth).join("/");
			entries.set(folder, (entries.get(folder) ?? new Set()).add(part));
		});
	}
	const unreasoned: string[] = [];
	let reasoned = 0;
	for (const [folder, inside] of entries) {
		if (inside.size <= MOST_ENTRIES) continue;
		if (saysWhyMany(join(ROOT, folder))) reasoned++;
		else unreasoned.push(folder || ".");
	}
	for (const file of files) {
		if (!isCode(file)) continue;
		const text = readFileSync(join(ROOT, file), "utf8");
		if (lineCount(text) <= MOST_LINES) continue;
		if (saysWhyLong(text)) reasoned++;
		else unreasoned.push(file);
	}
	return { unreasoned, reasoned };
}

/** The list as it stands: each file and folder still waiting. */
function listed(): Set<string> {
	return new Set(
		readFileSync(LIST, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#")),
	);
}

describe("the package's code", () => {
	it("tell a file that says why it's long from one that doesn't", () => {
		// A matcher that finds nothing passes everything. This is the check
		// that it reads the opening comment and nothing past it.
		expect(
			saysWhyLong(
				"/**\n * The panel.\n *\n * Long because it is one form.\n */\n",
			),
			"a block comment's sentence counts",
		).toBe(true);
		expect(
			saysWhyLong("#!/usr/bin/env bash\n# Sync.\n# Long because one flow.\n"),
			"a shell script's line comments after its shebang count",
		).toBe(true);
		expect(
			saysWhyLong("/** The panel. */\nconst x = 1; // Long because\n"),
			"a comment past the opening one doesn't count",
		).toBe(false);
		expect(
			saysWhyLong("/** It is not Long because of the tests. */\n"),
			"the words mid-sentence don't count",
		).toBe(false);
		expect(
			saysWhyLong("// Long becauseé\n"),
			"a letter past ASCII straight after isn't the words, as Rust reads it",
		).toBe(false);
		expect(
			isCode("lib/.ts"),
			"a file named only by its extension is code",
		).toBe(true);
		expect(
			isCode("flake.nix"),
			"code-health's languages past the package's are code",
		).toBe(true);
		expect(isCode("lib/vendor.min.js"), "a minified file is generated").toBe(
			false,
		);
		expect(lineCount("a\nb\n"), "a closing newline makes no line").toBe(2);
		expect(lineCount("a\nb"), "a last line without one counts").toBe(2);
	});

	it("say why a long file or crowded folder stays whole", WALK, () => {
		const waiting = listed();
		const unsaid = over().unreasoned.filter((path) => !waiting.has(path));
		expect(
			unsaid,
			`these are past ${MOST_LINES} lines or ${MOST_ENTRIES} entries: split each by what changes for one reason, or say why it stays whole, a file in its opening comment in a sentence beginning "Long because", a folder in its README.md in one beginning "Many entries because":\n${unsaid.join("\n")}`,
		).toEqual([]);
	});

	it("keep the waiting list no longer than what's left", WALK, () => {
		const still = new Set(over().unreasoned);
		const stale = [...listed()].filter((path) => !still.has(path));
		expect(
			stale,
			`these wait in tests/package/code/long-files-waiting.txt but are split, say why or are gone; take each off, since the list only shrinks:\n${stale.join("\n")}`,
		).toEqual([]);
	});
});
