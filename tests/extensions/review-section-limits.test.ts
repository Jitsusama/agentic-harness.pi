/**
 * The limits each section field states, against the shape the gate
 * enforces.
 *
 * The descriptions once typed their numbers out, and two the gate
 * enforced went unsaid: the ceiling on a sentence and on the Solution's
 * code spans. Each field also gives a word count to aim for below its
 * ceiling, since agents writing to a bare ceiling overshot it often
 * enough to cost a refused turn in about one TL;DR in seven.
 */

import {
	PR_SECTIONS,
	PR_SHAPE,
} from "@jitsusama/agentic-harness.core/sections";
import { describe, expect, it } from "vitest";
import {
	SECTION_DESCRIPTIONS,
	stackSections,
} from "../../extensions/review-integration/tools/sections.ts";

const FIELDS = ["tldr", "problem", "solution", "validation"] as const;

function rulesOf(field: (typeof FIELDS)[number]) {
	const section = PR_SECTIONS[FIELDS.indexOf(field)] ?? "";
	return PR_SHAPE.sections[section] ?? {};
}

describe("each section field states the limits the gate enforces", () => {
	for (const field of FIELDS) {
		it(`${field} names its word ceiling and a lower count to aim for`, () => {
			const { words } = rulesOf(field);
			const said = SECTION_DESCRIPTIONS[field];

			expect(said).toContain(`at most ${words}`);
			const aimed = Number(/Aim for about (\d+) words/.exec(said)?.[1]);
			expect(aimed).toBeGreaterThan(0);
			expect(aimed).toBeLessThan(words ?? 0);
		});
	}

	it("names the code spans wherever a section may hold any", () => {
		for (const field of FIELDS) {
			const { codeSpans } = rulesOf(field);
			if (!codeSpans) continue;
			expect(SECTION_DESCRIPTIONS[field]).toContain(`${codeSpans} code spans`);
		}
	});

	it("names the ceiling every sentence is held to", () => {
		expect(SECTION_DESCRIPTIONS.problem).toContain(
			`no sentence may pass ${PR_SHAPE.sentenceWords} words`,
		);
	});

	it("says the TL;DR's aim as 30 words, a quarter under its 40", () => {
		expect(SECTION_DESCRIPTIONS.tldr).toContain(
			"Aim for about 30 words; at most 40.",
		);
		expect(SECTION_DESCRIPTIONS.tldr).toContain("At most 2 sentences.");
	});

	it("leaves the contract to the stack's sections parameter, rather than saying it twice", () => {
		const stack = stackSections();
		for (const field of FIELDS) {
			expect(stack[field]).toMatchObject({ type: "string" });
			expect(stack[field]).not.toHaveProperty("description");
		}
	});
});
