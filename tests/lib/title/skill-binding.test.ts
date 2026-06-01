import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The title gate has no enumerable set to bind the way sections
 * do, so the drift guard is on the rule itself: the gate blocks
 * conventional-commit titles only because the skill forbids them.
 * If the skill ever drops that direction, these assertions fail,
 * forcing the gate and the skill to be reconciled rather than
 * silently diverging.
 */
function skill(relPath: string): string {
	return readFileSync(
		fileURLToPath(new URL(`../../../${relPath}`, import.meta.url)),
		"utf8",
	);
}

describe("title gate is bound to the skills it enforces", () => {
	it("github-cli-convention forbids conventional commit titles", () => {
		const text = skill("skills/github-cli-convention/SKILL.md");
		expect(text).toMatch(/not conventional commit/i);
	});

	it("the format skills each carry a Title section the block points at", () => {
		expect(skill("skills/github-pr-format/SKILL.md")).toMatch(/^## Title$/m);
		expect(skill("skills/github-issue-format/SKILL.md")).toMatch(/^## Title$/m);
	});
});
