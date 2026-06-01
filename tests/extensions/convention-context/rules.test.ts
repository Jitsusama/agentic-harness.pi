import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBindingRules } from "../../../extensions/convention-context/rules.js";
import { ISSUE_SECTIONS, PR_SECTIONS } from "../../../lib/sections/index.js";

function skill(relPath: string): string {
	return readFileSync(
		fileURLToPath(new URL(`../../../${relPath}`, import.meta.url)),
		"utf8",
	);
}

describe("buildBindingRules", () => {
	const rules = buildBindingRules();

	it("names every PR and issue section verbatim", () => {
		for (const heading of [...PR_SECTIONS, ...ISSUE_SECTIONS]) {
			expect(rules).toContain(heading);
		}
	});

	it("names each governing skill", () => {
		for (const skillName of [
			"prose-standard",
			"github-pr-format",
			"github-issue-format",
			"commit-format",
			"slack-guide",
		]) {
			expect(rules).toContain(skillName);
		}
	});

	it("states the prose prohibitions the prose-standard skill defines", () => {
		const prose = skill("skills/prose-standard/SKILL.md");
		// The block claims these rules, and prose-standard must back
		// each claim, or the resident reminder has drifted from its
		// source.
		expect(rules.toLowerCase()).toContain("emdash");
		expect(prose.toLowerCase()).toContain("emdash");
		expect(rules.toLowerCase()).toContain("canadian");
		expect(prose).toContain("Canadian");
	});

	it("stays compact", () => {
		// A resident block rides every prompt, so it must not balloon
		// the default context. Cap it well under a screenful.
		expect(rules.length).toBeLessThan(1200);
	});
});
