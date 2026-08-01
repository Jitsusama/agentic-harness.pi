/**
 * A parameter that serves only some of a tool's actions has to say so.
 *
 * These tools are action-dispatched: one registration, a dozen or more
 * verbs, and a parameter bag shared across all of them. Most parameters
 * apply to a handful of actions and are meaningless for the rest, and a
 * description that does not say which ones leaves the caller to guess
 * from the name. Guessing produces a call that is accepted and quietly
 * ignored, which is worse than a refusal.
 *
 * The rule is the one the exemplar surfaces already follow: open the
 * description by naming the actions it serves, as "For rerun:" or
 * "For propose and edit:". Three sibling rules from the same section
 * already ship as review-indexed, work-indexed and render-padding; this
 * is the fourth and the one that had no gate.
 *
 * It checks the opening, not the accuracy. A description that names the
 * wrong actions passes, which is the right way for a gate like this to
 * be wrong: the alternative is parsing the dispatcher to find out which
 * branches read a parameter, and a gate nobody can explain gets deleted
 * the first time it is inconvenient.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * The action-dispatched tool surfaces, and the parameters that serve
 * every action so legitimately need no prefix.
 *
 * Universal parameters are listed rather than detected. Which ones are
 * universal is a fact about the tool's design, and inferring it from
 * the text would make the gate agree with whatever was written.
 */
const SURFACES: readonly {
	file: string;
	universal: readonly string[];
}[] = [
	{
		file: "extensions/review-integration/tools/offer.ts",
		universal: ["action", "change", "repo"],
	},
	{
		file: "extensions/review-integration/tools/see.ts",
		universal: ["action", "change", "repo", "base", "head", "refs"],
	},
	// `items` is universal in the sense that matters here: it is the plural
	// form of the whole tool rather than a parameter belonging to some of its
	// actions, and every entry inside it names its own.
	{
		file: "extensions/review-integration/tools/say.ts",
		universal: ["action", "change", "repo", "items"],
	},
	{
		file: "extensions/review-integration/tools/draft.ts",
		universal: ["action", "change", "repo", "draft", "base", "head", "refs"],
	},
	{
		file: "extensions/work-integration/tools/tree.ts",
		universal: ["action", "tree", "repo"],
	},
];

/**
 * How a description that scopes itself opens.
 *
 * The colon belongs in the terminator set and leaving it out reported
 * the entire surface as undescribed, since "For propose:" is exactly
 * the form being asked for. A gate whose first run fails everything is
 * wrong about the rule, not right about the code.
 */
const NAMES_ITS_ACTIONS = /^For [a-z][a-zA-Z-]*(?:[ ,:]|$)/;

/**
 * Each parameter in a Type.Object schema, with its description.
 *
 * Read from the source rather than by importing, because importing a
 * tool module pulls in pi's runtime, which is not present in a test.
 */
function parametersOf(source: string): { name: string; description: string }[] {
	const found: { name: string; description: string }[] = [];
	// A property, then the first description string that follows it
	// before the next property begins.
	const property = /^\t\t\t([a-zA-Z][a-zA-Z0-9]*): Type\./gm;
	let match: RegExpExecArray | null = property.exec(source);
	for (; match !== null; match = property.exec(source)) {
		const name = match[1];
		if (name === undefined) continue;
		const next = property.lastIndex;
		// The next property at this depth, found by pattern rather than by
		// indexOf on the indent: a deeper line starts with the same three
		// tabs and would cut every block off at its first nested call,
		// which reported the whole surface as undescribed.
		const sibling = /\n\t\t\t[a-zA-Z]/.exec(source.slice(next));
		const block =
			sibling === null
				? source.slice(next)
				: source.slice(next, next + sibling.index);
		const described = /description:\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(block);
		found.push({ name, description: described?.[1] ?? "" });
	}
	return found;
}

describe("a parameter that serves some actions says which", () => {
	for (const surface of SURFACES) {
		it(`holds for ${surface.file}`, () => {
			const source = readFileSync(join(ROOT, surface.file), "utf8");
			const parameters = parametersOf(source);

			// A surface whose parameters cannot be read at all would pass
			// every assertion below by having nothing to check.
			expect(parameters.length).toBeGreaterThan(3);

			const silent = parameters
				.filter((p) => !surface.universal.includes(p.name))
				.filter((p) => !NAMES_ITS_ACTIONS.test(p.description))
				.map((p) => p.name);

			expect(silent).toEqual([]);
		});
	}

	it("would notice a parameter that names no action", () => {
		const pretend = [
			"\t\t\taction: Type.Union([]),",
			'\t\t\twhich: Type.Optional(Type.String({ description: "A pipeline." })),',
		].join("\n");

		const silent = parametersOf(pretend)
			.filter((p) => p.name !== "action")
			.filter((p) => !NAMES_ITS_ACTIONS.test(p.description));

		expect(silent.map((p) => p.name)).toEqual(["which"]);
	});

	it("accepts one that opens by naming them", () => {
		const pretend =
			'\t\t\twhich: Type.Optional(Type.String({ description: "For rerun: a pipeline." })),';

		expect(
			NAMES_ITS_ACTIONS.test(parametersOf(pretend)[0]?.description ?? ""),
		).toBe(true);
	});
});
