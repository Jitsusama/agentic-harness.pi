/**
 * The prose standard applies to this package's own markdown.
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
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProseViolations } from "../../lib/prose/index.js";

/** The rules about characters, as opposed to the ones about markup. */
const GLYPH_RULES = ["emdash", "curly-quote", "ellipsis"];

/** Every markdown file in the package. */
function markdownUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			// A worktree holds another checkout of this same repo, and
			// node_modules holds other people's prose.
			return [".git", "node_modules", ".worktrees"].includes(entry.name)
				? []
				: markdownUnder(path);
		}
		return entry.name.endsWith(".md") ? [path] : [];
	});
}

describe("this package's own markdown", () => {
	const files = markdownUnder(process.cwd());

	it("has markdown to check", () => {
		// A walk that found nothing would pass the rule below by default.
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
