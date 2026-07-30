/**
 * A capability nobody can find does not exist.
 *
 * The review tools took over from an extension with thirty-six actions
 * and now offer more than that across six tools. The measurement that
 * prompted the sibling gate on the browser tools applies here with more
 * force: an audit there spent forty of sixty-three calls on raw eval
 * while four shipping capabilities went unused, none of them missing,
 * all of them unfindable.
 *
 * Nothing mechanical stopped a new action shipping undiscoverable, and
 * the surface has been growing fast. So this checks that every action
 * every tool offers appears in the guide an agent reads when it knows
 * what it wants and not which verb provides it.
 *
 * It checks presence, not quality. Prose that names an action while
 * explaining it badly passes, which is the right way for a gate like
 * this to be wrong.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The tool modules, and the tool each one registers.
 *
 * The file name and the tool name differ, so the mapping is explicit:
 * `read.ts` registers `review` itself.
 */
const TOOLS: ReadonlyArray<readonly [file: string, tool: string]> = [
	["read", "review"],
	["see", "review_see"],
	["say", "review_say"],
	["ask", "review_ask"],
	["draft", "review_draft"],
	["offer", "review_offer"],
];

const GUIDE = "skills/review-guide/SKILL.md";

/**
 * Every action literal a tool's schema offers.
 *
 * Scoped to the action property's own union rather than every literal
 * in the file, or this sweeps up diff sides, verdicts and settlements
 * and demands the guide document "old" as an action.
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

describe("every action is written down somewhere", () => {
	const guide = read(GUIDE);

	for (const [file, tool] of TOOLS) {
		it(`documents every action ${tool} offers`, () => {
			const source = read(`extensions/review-integration/tools/${file}.ts`);
			const actions = actionsOf(source);
			// A tool with no actions would make this vacuous, and one of
			// these growing a union is exactly when the gate matters.
			expect(actions.length).toBeGreaterThan(0);

			// The incantation, not the bare word. A loose search passes for
			// any action whose name is ordinary English: `next`, `diff` and
			// `changes` all appear in prose about something else, and
			// eighteen actions passed that way before this was tightened.
			const missing = actions.filter(
				(action) => !guide.includes(`${tool} ${action}`),
			);

			expect(
				missing,
				`${GUIDE} never shows how to call these, so an agent reading it cannot discover them: ${missing.map((one) => `${tool} ${one}`).join(", ")}`,
			).toEqual([]);
		});
	}

	it("finds the actions it claims to be checking", () => {
		// Guards against the scoping regex silently matching nothing,
		// which would make every case above pass by having no work.
		const source = read("extensions/review-integration/tools/see.ts");

		expect(actionsOf(source).length).toBeGreaterThanOrEqual(8);
	});

	it("would notice an action the guide never shows how to call", () => {
		// The gate's own test. It reads source and searches prose, which
		// is exactly the kind of check that quietly passes.
		const invented = actionsOf(
			`action: Type.Union([Type.Literal("frobnicate")],`,
		);

		expect(invented).toEqual(["frobnicate"]);
		expect(guide.includes("review_see frobnicate")).toBe(false);
	});

	it("has no action that repeats its own tool's name", () => {
		// `review_see see` says the same thing twice, and the second
		// word is where the information should be.
		const repeats: string[] = [];
		for (const [file, tool] of TOOLS) {
			const stem = tool.replace("review_", "");
			for (const action of actionsOf(
				read(`extensions/review-integration/tools/${file}.ts`),
			)) {
				if (action === stem) repeats.push(`${tool} ${action}`);
			}
		}

		expect(repeats).toEqual([]);
	});

	it("has no action that names a different tool", () => {
		// An action called `draft` on the offering tool reads as though
		// it belongs to `review_draft`, which sends a reader to the wrong
		// place. That one existed: it is `unready` now, which also pairs
		// with the `ready` beside it.
		const tools = new Set(TOOLS.map(([, tool]) => tool));
		const misdirecting: string[] = [];
		for (const [file, tool] of TOOLS) {
			const stem = tool.replace("review_", "");
			for (const action of actionsOf(
				read(`extensions/review-integration/tools/${file}.ts`),
			)) {
				if (action !== stem && tools.has(`review_${action}`)) {
					misdirecting.push(`${tool} ${action} collides with review_${action}`);
				}
			}
		}

		expect(misdirecting).toEqual([]);
	});

	it("is not satisfied by the word appearing in unrelated prose", () => {
		// The failure mode that let eighteen actions through. `diff` is a
		// real action and the word is everywhere in the guide, so the
		// loose form proved nothing about whether it was documented.
		expect(guide).toContain("diff");
		expect(guide.includes("review_say diff")).toBe(false);
	});
});
