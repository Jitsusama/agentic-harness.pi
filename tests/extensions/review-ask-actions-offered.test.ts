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
	it("consults the stale-runtime advisory", () => {
		// The advisory existed for months with a docstring saying
		// downstream renderers would hoist it, and nothing but its own
		// test ever read it. So a session whose pi install had been
		// deleted by an upgrade got the same sentence once per reviewer
		// beside a retry hint, when retrying is the one thing that
		// cannot work. The library half is tested where it lives; this
		// is the half that was missing, and being called is all of it.
		expect(source).toContain("staleRuntimeAdvisory(run)");
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
});
