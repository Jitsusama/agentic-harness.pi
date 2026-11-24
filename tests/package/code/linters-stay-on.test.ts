/**
 * The linters stay on: the code's suppressions only fall.
 *
 * A suppression turns a linter off for a line, so what it would have said
 * goes unheard there for good. The rule here is to fix the code rather
 * than suppress the rule, and every `biome-ignore` carries its reason, but
 * nothing held the count: core.nix's code-health, which reads this
 * repository each hour, counted 53 on 23 November, and its hourly
 * target only reports, so nothing stopped a change adding one.
 * So the suppressions found before this check are listed per file in
 * `suppressions-waiting.txt`, and the list only shrinks: a file may not
 * gain one, and a file that loses one has its count lowered. merge-gate.sh
 * runs main's copy of this over every change it merges, and refuses a
 * change whose list holds a line or a count main's doesn't.
 *
 * A suppression is counted as code-health counts it (its `suppresses` in
 * modules/code-health/src/measure.rs), so the hourly figure and this check
 * agree: a line whose comment, by its language's own mark, opens with one
 * of that language's markers, where no quote before the mark is left
 * open, a mark found by stepping past the last one whole. A string naming
 * a marker is no suppression, and nor is a block comment, which
 * code-health doesn't read either. Whoever changes one changes the other.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extensionOf, isCode, packageFiles } from "./package-files.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The shrink-only list of files and how many suppressions each still has. */
const LIST = join(import.meta.dirname, "suppressions-waiting.txt");

/** How long a walk of the whole tree may take on a busy machine. */
const WALK = { timeout: 60_000 };

/** A comment mark and the markers that, opening its comment, suppress. */
interface Marks {
	readonly mark: string;
	readonly markers: readonly string[];
}

const HASH_SHELL: Marks = { mark: "#", markers: ["shellcheck disable"] };
const SLASH_SCRIPT: Marks = {
	mark: "//",
	markers: [
		"biome-ignore",
		"eslint-disable",
		"@ts-ignore",
		"@ts-expect-error",
		"@ts-nocheck",
	],
};
const TERRAFORM = ["tflint-ignore", "trivy:ignore", "tfsec:ignore"];

/** Each language's ways of turning its linter off, by file extension. */
const BY_EXTENSION: Readonly<Record<string, readonly Marks[]>> = {
	py: [
		{
			mark: "#",
			markers: ["noqa", "type: ignore", "pyright: ignore", "pylint: disable"],
		},
	],
	sh: [HASH_SHELL],
	bash: [HASH_SHELL],
	qml: [{ mark: "//", markers: ["qmllint disable"] }],
	js: [SLASH_SCRIPT],
	mjs: [SLASH_SCRIPT],
	cjs: [SLASH_SCRIPT],
	ts: [SLASH_SCRIPT],
	tsx: [SLASH_SCRIPT],
	nix: [{ mark: "#", markers: ["deadnix: skip"] }],
	tf: [
		{ mark: "#", markers: TERRAFORM },
		{ mark: "//", markers: TERRAFORM },
	],
};

/** Rust's attributes that let a lint off, at a line's start. */
const RUST_ATTRIBUTES = ["#[allow(", "#![allow(", "#[expect(", "#![expect("];

/** Whether a line's comment, opening at one of `mark`'s places, suppresses. */
function commentSuppresses(line: string, { mark, markers }: Marks): boolean {
	for (
		let at = line.indexOf(mark);
		at !== -1;
		// Past the whole mark, as measure.rs's match_indices steps, so the
		// second and third slashes of `///` are no comment of their own.
		at = line.indexOf(mark, at + mark.length)
	) {
		const before = line.slice(0, at);
		const quoted = ['"', "'"].some(
			(quote) => before.split(quote).length % 2 === 0,
		);
		const said = line.slice(at + mark.length).trimStart();
		if (!quoted && markers.some((marker) => said.startsWith(marker))) {
			return true;
		}
	}
	return false;
}

/** Whether a line of the file at `path` turns a linter off. */
function suppresses(path: string, line: string): boolean {
	const extension = extensionOf(path);
	if (extension === "rs") {
		const trimmed = line.trimStart();
		return RUST_ATTRIBUTES.some((attribute) => trimmed.startsWith(attribute));
	}
	const ways = BY_EXTENSION[extension] ?? [];
	return ways.some((marks) => commentSuppresses(line, marks));
}

/** The code files, less what's generated, as code-health reads them. */
function codeFiles(): string[] {
	return packageFiles(ROOT).filter(isCode);
}

/** Each file's suppressions, for the files that have any. */
function counted(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const file of codeFiles()) {
		const extension = extensionOf(file);
		if (extension !== "rs" && BY_EXTENSION[extension] === undefined) continue;
		const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
		const count = lines.filter((line) => suppresses(file, line)).length;
		if (count > 0) counts.set(file, count);
	}
	return counts;
}

/** The list as it stands: each file and the count it may still have. */
function listed(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of listLines()) {
		const [file, count] = line.split(/\s+/);
		if (file && count) counts.set(file, Number(count));
	}
	return counts;
}

/** The list's lines that aren't comments or blank. */
function listLines(): string[] {
	return readFileSync(LIST, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
}

describe("the package's code", () => {
	it("tell a suppression from a line that only names one", () => {
		// A matcher that finds nothing passes everything. This is the check
		// that it finds each language's own way and lets the rest by.
		expect(
			suppresses("a.ts", "\t// biome-ignore lint/style: the API's own name"),
			"Biome's comment is found",
		).toBe(true);
		expect(
			suppresses("a.ts", "const a = 1; // @ts-expect-error: the old types"),
			"a comment after code on its line is found",
		).toBe(true);
		expect(
			suppresses("a.ts", 'const said = "// biome-ignore";'),
			"a marker inside a string is none",
		).toBe(false);
		expect(
			suppresses("a.ts", "/* biome-ignore lint: block */"),
			"a block comment is none, as code-health reads it",
		).toBe(false);
		expect(
			suppresses("a.ts", "// It isn't biome-ignore that's wanted here."),
			"the marker past the comment's opening is none",
		).toBe(false);
		expect(
			suppresses("run.sh", "# shellcheck disable=SC2086"),
			"shellcheck's directive is found in a script",
		).toBe(true);
		expect(
			suppresses("run.ts", "# shellcheck disable=SC2086"),
			"another language's mark is none",
		).toBe(false);
		expect(
			suppresses("lib.rs", "    #[allow(dead_code)]"),
			"Rust's attribute is found at a line's start",
		).toBe(true);
		expect(
			suppresses("a.ts", "/// biome-ignore lint: a doc comment"),
			"a marker after a third slash is none, as code-health reads it",
		).toBe(false);
		expect(
			suppresses(
				"a.ts",
				"// See below. // biome-ignore lint: the API's own name",
			),
			"a second mark on a line opens a comment of its own",
		).toBe(true);
		expect(
			suppresses("lib/.ts", "// biome-ignore lint: the API's own name"),
			"a file named only by its extension is that language's, as Rust reads it",
		).toBe(true);
	});

	it("read every line of the list as a file and a count above 0", () => {
		// A count that won't parse, or a 0, would exempt its file for good or
		// never be flagged as stale.
		const unreadable = listLines().filter(
			(line) => !/^\S+\s+[1-9]\d*$/.test(line),
		);
		expect(
			unreadable,
			`these lines of tests/package/code/suppressions-waiting.txt aren't a file and a count above 0; write each as "path count", or take it off at 0:\n${unreadable.join("\n")}`,
		).toEqual([]);
	});

	it("turn a linter off nowhere it wasn't off before", WALK, () => {
		const now = counted();
		const before = listed();
		const grown = [...now]
			.filter(([file, count]) => count > (before.get(file) ?? 0))
			.map(
				([file, count]) => `${file}: ${count}, listed ${before.get(file) ?? 0}`,
			);
		expect(
			grown,
			`these files turn a linter off more often than tests/package/code/suppressions-waiting.txt allows: fix the code so the linter passes it, rather than suppressing the rule:\n${grown.join("\n")}`,
		).toEqual([]);
	});

	it("keep the list of suppressions no longer than what's left", WALK, () => {
		const now = counted();
		const stale = [...listed()]
			.filter(([file, count]) => count > (now.get(file) ?? 0))
			.map(
				([file, count]) => `${file} ${now.get(file) ?? 0} (listed ${count})`,
			);
		expect(
			stale,
			`these files turn a linter off less often than tests/package/code/suppressions-waiting.txt allows; lower each to the count given, or remove it at 0, since the list only shrinks:\n${stale.join("\n")}`,
		).toEqual([]);
	});
});
