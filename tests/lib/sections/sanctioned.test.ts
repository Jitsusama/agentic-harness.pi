import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ISSUE_SECTIONS,
	PR_SECTIONS,
} from "../../../lib/sections/sanctioned.js";

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

	it("the two artifacts share a Situation section but differ after it", () => {
		expect(PR_SECTIONS[0]).toBe(ISSUE_SECTIONS[0]);
		expect(PR_SECTIONS[1]).not.toBe(ISSUE_SECTIONS[1]);
	});
});
