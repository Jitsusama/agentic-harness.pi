/**
 * Every action the tool handles is an action the tool offers.
 *
 * `release` was implemented, dispatched, named in the tool's own description and
 * documented in the skill, and left out of the parameter schema. So the refusal that
 * tells you to release an id named a way out the schema would not accept: the caller
 * reads "release this one", passes it, and the call is rejected before it arrives.
 *
 * Three of the four places agreed, which is why nobody noticed. A schema is the only one
 * of them a caller actually meets.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ASK = join(
	import.meta.dirname,
	"..",
	"..",
	"extensions",
	"review-integration",
	"tools",
	"ask.ts",
);

const source = readFileSync(ASK, "utf8");

/** What the parameter schema will accept. */
function offered(): Set<string> {
	const union = source.slice(
		source.indexOf("action: Type.Optional("),
		source.indexOf("intent:"),
	);
	return new Set(
		[...union.matchAll(/Type\.Literal\("([a-z-]+)"\)/g)].map(([, a]) => a),
	);
}

/** What the dispatcher will act on. */
function handled(): Set<string> {
	return new Set([...source.matchAll(/case "([a-z-]+)":/g)].map(([, a]) => a));
}

describe("the round's answer", () => {
	it("is composed in the library and only painted here", () => {
		// What a round says used to be assembled in this file, where no
		// test could reach the order or the wording, and both of the
		// bugs that only the wiring showed were living in it: a sentence
		// pointing above itself at failures printed below, and an
		// advisory hoisted over a roll call that repeated it. The
		// composition is tested where it now lives. What is left here
		// is a brush, and a brush is worth one assertion: that nothing
		// has quietly started composing again.
		expect(source).toContain("roundAnswer(run, { ...also, warnings, caveat })");
		expect(source).not.toContain("whole story");
	});

	it("paints every answer with the same brush, the start included", () => {
		// The started round was the eighth answer and the only one that
		// still composed itself, so it printed the tree caveat last and
		// bare while the other seven put the identical sentence second
		// and marked. One caller counting is the whole check: there is
		// no other way to produce an answer here.
		expect(source).not.toContain("warnings.map((warning) =>");
	});

	it("gives a retry the whole answer, not just the head", () => {
		// Retrying is what a reader does after being told a reviewer
		// failed, so it is the last place that should withhold the one
		// diagnosis saying a retry cannot work. It used to print the
		// summary line alone.
		expect(source).toContain("answerFor(updated, warnings, tree.caveat, {");
	});
});

describe("review_ask", () => {
	it("offers every action it handles", () => {
		const missing = [...handled()].filter((a) => !offered().has(a));

		expect(missing).toEqual([]);
	});

	it("handles every action it offers", () => {
		// The other direction, which would advertise a verb that falls through
		// to whatever the default is rather than doing what it says.
		const dangling = [...offered()].filter(
			(a) => !handled().has(a) && a !== "runs",
		);

		expect(dangling).toEqual([]);
	});

	it("reads a real schema, not an empty one", () => {
		// Both assertions above pass trivially against a mis-sliced file.
		expect(offered()).toContain("council");
		expect(handled()).toContain("judge");
	});

	it("lets every round kind be told who to ask", () => {
		// A per-call override that reached the council and not the judge
		// would be worse than none: the round runs, bills what it bills,
		// and half of it ignored the instruction. The parameter is
		// required rather than optional for the same reason, so the
		// compiler names any call site that forgets.
		const asks = source.match(/rosterOrThrow\(/g) ?? [];
		const told = source.match(/rosterOrThrow\(params\)/g) ?? [];

		expect(asks.length).toBeGreaterThan(6);
		// One more ask than tellings: the declaration itself.
		expect(told).toHaveLength(asks.length - 1);
	});
});
