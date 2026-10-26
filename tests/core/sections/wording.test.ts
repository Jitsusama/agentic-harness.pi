import { describe, expect, it } from "vitest";
import {
	detectShapeViolations,
	formatShapeBlock,
	PR_SECTIONS,
	PR_SHAPE,
} from "../../../lib/core/sections/index.ts";

const [TLDR, PROBLEM, SOLUTION, VALIDATION] = PR_SECTIONS;

/** A body that keeps every rule, to be broken one section at a time. */
function body(parts: Partial<Record<string, string>> = {}): string {
	const text = {
		[TLDR]: "Merging with a short commit id now works the first time.",
		[PROBLEM]: "Merging failed 23 times in two months.",
		[SOLUTION]: "Merge expands a short id before it asks GitHub.",
		[VALIDATION]:
			"A new test sends a short id and checks the full one arrives.",
		...parts,
	};
	return PR_SECTIONS.map((h) => `${h}\n\n${text[h]}`).join("\n\n");
}

const found = (b: string) =>
	detectShapeViolations(b, PR_SHAPE).map((v) => ({
		section: v.section,
		rule: v.rule,
		word: v.word,
	}));

describe("wording rules", () => {
	it("passes a body that keeps the shape", () => {
		expect(found(body())).toEqual([]);
	});

	it("refuses a TL;DR that opens with the PR rather than what changed", () => {
		expect(
			found(body({ [TLDR]: "This PR makes merging work first time." })),
		).toEqual([{ section: TLDR, rule: "opener", word: "This PR" }]);
	});

	it("refuses bold in the TL;DR", () => {
		expect(
			found(body({ [TLDR]: "Merging now **works** the first time." })),
		).toEqual([{ section: TLDR, rule: "emphasis", word: "**" }]);
	});

	it("names the word that broke the rule and what to write instead", () => {
		const message = formatShapeBlock(
			detectShapeViolations(
				body({ [TLDR]: "This change makes merging work." }),
				PR_SHAPE,
			),
			"pull request",
			"github-pr-format",
		);
		expect(message).toContain('"This change"');
		expect(message).toContain("open with the thing that changed");
		expect(message).toContain("Before You Submit");
	});
});

// Each of these was refused by one of the nine word-list rules that
// have since been removed, one sentence per rule, and each is an honest
// sentence. The rules that fired on prose they were not tuned on were
// wrong more often than right.
// The judgement they tried to make is the skill's, not the gate's.
describe("sentences the gate leaves to the writer's judgement", () => {
	it.each([
		[
			"a universal that is literally true",
			TLDR,
			"The guard now runs after every commit.",
		],
		[
			"a superlative that is not a hedge",
			VALIDATION,
			"The new test feeds the line most likely to exceed the cap.",
		],
		[
			"list items that open with an article",
			SOLUTION,
			"Three tools recover:\n- The merge expands a short id.\n- The lookup restarts its server.\n- The query shares one update.",
		],
		[
			"a reason given without a connective",
			SOLUTION,
			"Merge expands a short id first: GitHub accepts only the full one.",
		],
		[
			"a product's own term that looks like session talk",
			PROBLEM,
			"The phase 2 migration failed on 3 of 40 shops.",
		],
		[
			"a statistical use of a selling word",
			VALIDATION,
			"The two arms did not differ significantly on any measure.",
		],
		[
			"a description of starting state",
			TLDR,
			"Caches start empty now, where they were initially filled from disk.",
		],
		[
			"a technical use of an assurance word",
			VALIDATION,
			"The robust median is reported beside the mean.",
		],
		[
			"a pass that says where it ran",
			VALIDATION,
			"The tests pass in CI on Linux and macOS.",
		],
	])("accepts %s", (_what, section, text) => {
		expect(found(body({ [section]: text }))).toEqual([]);
	});
});
