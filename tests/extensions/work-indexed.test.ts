/**
 * A work verb nobody can find does not exist.
 *
 * The sibling gate on the review tools has caught three actions shipping
 * undiscoverable, most recently within an hour of this file being written. The
 * work tool then grew from seven actions to seventeen in one night with no skill
 * documenting any of them, which is the same fault from the other end: a surface
 * nothing teaches.
 *
 * So the same check, aimed at the work surface. It checks presence, not quality:
 * prose that names an action while explaining it badly passes, which is the
 * right way for a gate like this to be wrong.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GUIDE = "skills/work-guide/SKILL.md";
const TOOL = "work";

/**
 * Every action literal the schema offers.
 *
 * Scoped to the action property's own union rather than every literal in the
 * file, which would sweep up unrelated enums and demand the guide document them.
 */
function actionsOf(source: string): readonly string[] {
	const start = source.indexOf("action: Type.");
	if (start < 0) return [];
	const listEnd = source.indexOf("],", start);
	const union = source.slice(start, listEnd < 0 ? undefined : listEnd);
	const found = new Set<string>();
	const literal = /Type\.Literal\("([a-zA-Z-]+)"\)/g;
	let match: RegExpExecArray | null = literal.exec(union);
	for (; match !== null; match = literal.exec(union)) {
		const name = match[1];
		if (name) found.add(name);
	}
	return [...found];
}

function read(relative: string): string {
	return readFileSync(join(process.cwd(), relative), "utf8");
}

describe("every work verb is written down somewhere", () => {
	const guide = read(GUIDE);
	const source = read("extensions/work-integration/tools/tree.ts");

	it("documents every action work offers", () => {
		const actions = actionsOf(source);
		// A vacuous pass is the failure mode of a gate like this, and the union
		// growing is exactly when it matters.
		expect(actions.length).toBeGreaterThan(0);

		// The incantation, not the bare word. Half these names are ordinary
		// English that appears in prose about something else: "status", "branch",
		// "tree" and "push" would all pass a loose search.
		const missing = actions.filter(
			(action) => !guide.includes(`${TOOL} ${action}`),
		);

		expect(
			missing,
			`${GUIDE} never shows how to call these, so an agent reading it cannot discover them: ${missing.map((one) => `${TOOL} ${one}`).join(", ")}`,
		).toEqual([]);
	});

	it("finds the actions it claims to be checking", () => {
		// Guards against the scoping regex silently matching nothing, which
		// would make the case above pass by having no work to do.
		expect(actionsOf(source).length).toBeGreaterThanOrEqual(16);
	});

	it("would notice an action the guide never shows how to call", () => {
		// The gate's own test. It reads source and searches prose, which is
		// exactly the kind of check that quietly passes.
		const invented = actionsOf(
			`action: Type.Union([Type.Literal("frobnicate")],`,
		);

		expect(invented).toEqual(["frobnicate"]);
		expect(guide.includes(`${TOOL} frobnicate`)).toBe(false);
	});

	it("names the rules that only live in AGENTS.md nowhere else", () => {
		// The three that were AGENTS.md-only before the guide existed. Each is a
		// property somebody loses money on: a shared snapshot edited as a
		// worktree, a tree repointed over uncommitted work, and a worktree cut
		// outside the broker that nothing will ever clean up.
		expect(guide).toMatch(/snapshot/i);
		expect(guide).toMatch(/status/i);
		expect(guide).toMatch(/git worktree/);
	});
});
