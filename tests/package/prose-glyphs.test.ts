/**
 * The prose standard applies to this package's own prose, in
 * markdown and in TypeScript both.
 *
 * It was stated absolutely and violated 150 times across 20 files, in a
 * repo that ships the detector which finds them. The gate that held
 * authored artifacts to the rule never looked at the documentation
 * beside it, so the standard held everywhere except at home.
 *
 * Scoped to the three glyph rules on purpose. The detector also flags
 * markdown emphasis and backticks in running prose, which documentation
 * that shows syntax trips constantly and legitimately: the prose
 * standard's own skill file scores 84 that way while containing five
 * glyphs, every one of them quoting the rule it teaches. A gate over
 * the unscoped count would have to be suppressed everywhere useful,
 * which is how a gate stops being read.
 *
 * TypeScript came second, and for the same reason: 124 glyphs across 55
 * files, in comments, progress messages and test names. The standard
 * names code comments explicitly, and a message a person reads is prose
 * whichever file it lives in.
 *
 * The ellipsis is deliberately not checked in TypeScript, and finding
 * out why cost three broken tests. In rendered output it is a glyph one
 * column wide, and the truncation helpers slice to `max - 1` precisely
 * so that appending it lands on exactly `max`. Rewriting it as three
 * periods makes every one of those strings two columns too wide, which
 * in a terminal means wrapping or clipping rather than a visible
 * failure. So the rule for this codebase is by role, not by character:
 * a truncation or elision marker is a glyph and stays, a sentence gets
 * three periods. Only the emdash and curly quotes are mechanical enough
 * to gate.
 *
 * Two sites keep an emdash because they have to name the character to
 * do their job: `lib/ui/tab-strip.ts`, which draws one beside its own
 * diamonds and crosses, and `lib/gate/decision.ts`, which documents a
 * signature by quoting it. The prose detector's own tests are exempt
 * for the same reason a code span is: a fixture proving the rule has to
 * break it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProseViolations } from "../../lib/prose/index.js";

/** The rules about characters, as opposed to the ones about markup. */
const GLYPH_RULES = ["emdash", "curly-quote", "ellipsis"];

/**
 * Every file of one extension that this repo actually tracks.
 *
 * Asking git rather than walking the disk, because the rule is about the
 * prose this package ships and a walk cannot tell that from whatever else
 * is lying around. This was not a theoretical distinction: a working
 * checkout had 73 markdown files under a gitignored `.pi/plans/` and one
 * of them tracked, so the walking version failed on 72 files nobody could
 * commit, while a fresh worktree with none of that clutter passed. A gate
 * whose answer depends on which checkout you run it in is not a gate.
 *
 * It also retires the hand-maintained skip list. `.git`, `node_modules`
 * and `.worktrees` were named there so the walk would avoid them, and a
 * tracked-file listing never mentions them in the first place.
 */
function trackedFiles(extension: string): string[] {
	const listing = execFileSync(
		"git",
		["-C", process.cwd(), "ls-files", "-z", `*${extension}`],
		{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	return listing
		.split("\0")
		.filter((path) => path !== "")
		.map((path) => join(process.cwd(), path));
}

/**
 * Files that must contain a forbidden glyph to do their job.
 *
 * Deliberately a short list of exact paths rather than a pattern.
 * A pattern would quietly grow to cover the next file somebody did not
 * want to fix, and the point of the gate is that "never" means never
 * everywhere else.
 */
const GLYPH_BEARING = [
	"lib/ui/tab-strip.ts",
	"lib/gate/decision.ts",
	"tests/lib/prose/detect.test.ts",
	"tests/lib/prose/block.test.ts",
	"tests/scripts/convention-recurrence.test.ts",
];

/** Every TypeScript file whose prose is held to the standard. */
function heldTypescript(): string[] {
	return trackedFiles(".ts").filter(
		(path) => !GLYPH_BEARING.includes(path.replace(`${process.cwd()}/`, "")),
	);
}

/**
 * Whether a line is a separator glyph in rendered output.
 *
 * An emdash alone in a string is a placeholder in a listing, sitting
 * beside its own ticks and crosses, and the one handed to `join` is a
 * delimiter. Both are typography doing a bullet's job rather than
 * sentences. An emdash between two interpolated values is prose, and is
 * not excused here.
 */
function isRenderedSeparator(line: string): boolean {
	return (
		/return\s*["'`]\s*\u2014\s*["'`]/.test(line) ||
		/["'`]\s*\u2014\s*["'`]\s*\)/.test(line)
	);
}

describe("this package's own TypeScript", () => {
	const files = heldTypescript();

	it("has TypeScript to check", () => {
		expect(files.length).toBeGreaterThan(200);
	});

	it("uses no emdash and no curly quote in its prose", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const lines = readFileSync(file, "utf8").split("\n");
			for (const [index, line] of lines.entries()) {
				if (isRenderedSeparator(line)) continue;
				if (/[\u2014\u2018\u2019\u201c\u201d]/.test(line)) {
					offenders.push(
						`${file.replace(`${process.cwd()}/`, "")}:${index + 1}`,
					);
				}
			}
		}

		expect(
			offenders,
			`The prose standard forbids these outright, in comments and strings alike. Restructure with a colon, a semi-colon, parentheses or a new sentence:\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("leaves the ellipsis alone, since it is a one-column glyph here", () => {
		// The truncation helpers slice to `max - 1` so appending it lands on
		// exactly `max`. Three periods would overflow every one of them.
		const truncation = ["`$", "{v.slice(0, max - 1)}\u2026`"].join("");
		expect(/[\u2014\u2018\u2019\u201c\u201d]/.test(truncation)).toBe(false);
	});

	it("still permits a separator glyph in rendered output", () => {
		expect(isRenderedSeparator('\treturn "\u2014";')).toBe(true);
		expect(isRenderedSeparator('parts.join(" \u2014 ")')).toBe(true);
		expect(isRenderedSeparator("// a comment \u2014 with prose")).toBe(false);
		// The direction this exception would drift, pinned shut.
		const interpolated = ["`$", "{name} \u2014 $", "{count} members`"].join("");
		expect(isRenderedSeparator(interpolated)).toBe(false);
	});
});

describe("this package's own markdown", () => {
	const files = trackedFiles(".md");

	it("has markdown to check", () => {
		// A listing that found nothing would pass the rule below by default.
		expect(files.length).toBeGreaterThan(50);
	});

	it("uses no emdash, curly quote or Unicode ellipsis", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const found = detectProseViolations(readFileSync(file, "utf8")).filter(
				(violation) => GLYPH_RULES.includes(violation.kind),
			);
			if (found.length > 0) {
				offenders.push(
					`${file.replace(`${process.cwd()}/`, "")}: ${found.length}`,
				);
			}
		}

		expect(
			offenders,
			`The prose standard forbids these outright. Restructure with a colon, a semi-colon, parentheses or a new sentence, and write three periods rather than an ellipsis:\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("would notice one that came back", () => {
		// The gate's own test, since a filter naming three rule kinds is
		// exactly the kind of thing that silently matches none of them.
		const found = detectProseViolations("This leaks \u2014 badly.").filter(
			(violation) => GLYPH_RULES.includes(violation.kind),
		);

		expect(found).toHaveLength(1);
	});

	it("does not object to one quoted inside code", () => {
		// Which is how the three surviving instances are written: the
		// coverage matrix and the prose standard both have to name the
		// characters they forbid.
		const found = detectProseViolations(
			"No emdashes (`\u2014`) and no ellipsis (`\u2026`).",
		).filter((violation) => GLYPH_RULES.includes(violation.kind));

		expect(found).toEqual([]);
	});
});
