import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ISSUE_SECTIONS,
	PR_SECTIONS,
} from "../../../lib/core/sections/index.ts";

/**
 * Read the level-3 headings inside a skill's "## Body Structure"
 * section. This is the same span a reader sees as the sanctioned
 * sections, so the constant is bound to the skill's own prose: if
 * the skill renames or reorders a section, this extraction
 * changes and the assertion below fails until the constant is
 * brought back in line.
 */
function skillSections(relPath: string): string[] {
	const path = fileURLToPath(new URL(`../../../${relPath}`, import.meta.url));
	const lines = readFileSync(path, "utf8").split("\n");
	const headings: string[] = [];
	let inBodyStructure = false;
	for (const line of lines) {
		if (/^## /.test(line)) {
			inBodyStructure = /^## Body Structure\s*$/.test(line);
			continue;
		}
		if (inBodyStructure && /^### /.test(line)) {
			headings.push(line.trim());
		}
	}
	return headings;
}

describe("sanctioned sections match the format skills", () => {
	it("PR_SECTIONS matches github-pr-format Body Structure", () => {
		expect(skillSections("skills/github-pr-format/SKILL.md")).toEqual([
			...PR_SECTIONS,
		]);
	});

	it("ISSUE_SECTIONS matches github-issue-format Body Structure", () => {
		expect(skillSections("skills/github-issue-format/SKILL.md")).toEqual([
			...ISSUE_SECTIONS,
		]);
	});

	it("the PR opens with a TL;DR, which the issue does not yet have", () => {
		// A PR is read by somebody deciding whether to trust a change they
		// will not read, so it leads with the eight-second version. Issues
		// keep their own set until they get one of their own.
		expect(PR_SECTIONS[0]).toContain("TL;DR");
		expect(ISSUE_SECTIONS).not.toContain(PR_SECTIONS[0]);
	});
});
