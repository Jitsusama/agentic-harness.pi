/**
 * Every gate in the package wears the same nameplate.
 *
 * A confirmation title is the first thing read and the thing that says
 * which of several open loops this panel belongs to. When one family
 * writes `Commit` and another writes `Close owner/repo#4?`, the second
 * reads as a different application, and the whole argument for these
 * gates is that a person learns the shape once.
 *
 * The convention, taken from commit-guardian, which had it first:
 *
 * - A Title Case phrase naming the act, not a sentence asking permission.
 *   The panel is already a question; its footer says so. A title ending
 *   in a question mark asks it twice.
 * - No leading space. The panel indents the title itself, so a space in
 *   the string double-indents it.
 *
 * The scan is deliberately narrow: the first argument to a confirm call
 * is the title, so there is no guessing about which strings are titles.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every tracked extension source, asked of git rather than walked.
 *
 * The neighbouring gates take the same route and say why: a walk cannot
 * tell what this package ships from whatever is lying around in a
 * working checkout, and a gate whose answer depends on which checkout
 * you run it in is not a gate.
 */
function trackedSources(): string[] {
	const listing = execFileSync(
		"git",
		["-C", process.cwd(), "ls-files", "-z", "extensions/*.ts"],
		{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	return listing.split("\0").filter((path) => path !== "");
}

/** The confirm calls whose first argument is a panel title. */
const CONFIRMS =
	/\b(?:confirmWrite|confirmBatch)\(\s*[^,]+,\s*([`"'])(.+?)\1/gs;

/** Titles built by a helper rather than written at the call site. */
const BUILDERS = /\breturn\s+([`"'])([A-Z][^`"']*?)\1\s*;/g;

/** Every title this package hands to a confirmation panel. */
function titles(): { file: string; title: string }[] {
	const found: { file: string; title: string }[] = [];
	for (const file of trackedSources()) {
		const text = readFileSync(join(process.cwd(), file), "utf8");
		for (const [, , title] of text.matchAll(CONFIRMS)) {
			if (title) found.push({ file, title });
		}
		// batchTitle and its kind: a function whose whole job is the title.
		if (/function (?:batchTitle|titleFor)\b/.test(text)) {
			for (const [, , title] of text.matchAll(BUILDERS)) {
				if (title) found.push({ file, title });
			}
		}
	}
	return found;
}

describe("what a confirmation panel calls itself", () => {
	it("finds the titles at all, so a passing scan means something", () => {
		expect(titles().length).toBeGreaterThan(10);
	});

	it("names the act rather than asking a second time", () => {
		const asking = titles().filter((one) => one.title.trim().endsWith("?"));
		expect(
			asking.map((one) => `${one.file}: ${one.title}`),
			"the panel is already a question; its footer says so",
		).toEqual([]);
	});

	it("leaves the indenting to the panel", () => {
		const padded = titles().filter((one) => one.title.startsWith(" "));
		expect(
			padded.map((one) => `${one.file}: ${one.title}`),
			"the panel adds a leading space, so this one double-indents",
		).toEqual([]);
	});

	it("opens in the case a title is written in", () => {
		const lower = titles().filter((one) => /^[a-z]/.test(one.title));
		expect(lower.map((one) => `${one.file}: ${one.title}`)).toEqual([]);
	});
});
