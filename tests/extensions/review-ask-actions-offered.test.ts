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

/**
 * What the dispatcher will act on.
 *
 * Two shapes, because not every action waits for the switch. One that
 * needs no change bound is answered before the binding, since binding
 * first would refuse it from the position it exists to be reachable
 * from, and a gate that only knew about `case` would call that action
 * unhandled.
 */
function handled(): Set<string> {
	return new Set([
		...[...source.matchAll(/case "([a-z-]+)":/g)].map(([, a]) => a),
		...[...source.matchAll(/action === "([a-z-]+)"/g)].map(([, a]) => a),
	]);
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

	it("lets every round kind be told who to ask, and who it asks", () => {
		// A per-call override reaching the council and not the judge would
		// be worse than none: the round runs, bills what a round bills,
		// and half of it ignored the instruction.
		//
		// The first version of this counted call sites, which tolerated
		// two round kinds dropping out of the file entirely and said
		// nothing about the second argument at all. Each round is named,
		// with the half of the roster it actually asks, because that is
		// what the override is checked against.
		const asksOf: Record<string, string> = {
			askCouncil: "reviewers",
			startRound: "reviewers",
			askCritique: "reviewers",
			askStack: "reviewers",
			askJudge: "judge",
			askAudit: "judge",
		};

		const wrong = Object.entries(asksOf).flatMap(([round, asks]) => {
			const at = source.indexOf(`async function ${round}(`);
			if (at === -1) return [`${round} is gone`];
			const body = source.slice(at);
			const opens = body.indexOf("const charters");
			if (opens === -1) return [`${round} reads no lenses at all`];
			const call = body.slice(0, opens);
			return call.includes(`rosterOrThrow(params, "${asks}")`)
				? []
				: [`${round} does not ask for "${asks}"`];
		});

		expect(wrong).toEqual([]);
		// And nowhere reads a roster without saying which round it is for,
		// which the compiler enforces but only while the parameter stays
		// required.
		expect(source).not.toMatch(/rosterOrThrow\(params\)/);
	});

	it("reads every round's lenses out of the tree that round reads", () => {
		// The composition is driven for real elsewhere. What cannot be
		// driven is whether these seven call sites hand it the right tree,
		// and that is exactly where the last four PRs put their bugs: a
		// tested helper beside an unproven call site. Substituting the
		// session's directory for the change's tree broke nothing in the
		// suite until this existed.
		//
		// A lens from the wrong tree is the cheap version of the mistake
		// that cost $75.63: real code read through a lens written for a
		// codebase nobody is reviewing.
		// Every function that resolves a tree, discovered rather than
		// listed. A whitelist covers the rounds that existed the day it was
		// written and waves an eighth one through, which is the failure the
		// gate two tests up already had once.
		const rounds = [...source.matchAll(/async function (\w+)\(/g)].flatMap(
			([, name]) => {
				const at = source.indexOf(`async function ${name}(`);
				const next = source.indexOf("\nasync function ", at + 1);
				const body = source.slice(at, next === -1 ? undefined : next);
				return body.includes("await treeForRound(") ? [{ name, body }] : [];
			},
		);

		// The discovery itself has to find something, or the sweep below
		// passes over nothing at all and reports a clean bill.
		expect(rounds.length).toBeGreaterThanOrEqual(7);

		const wrong = rounds.flatMap(({ name, body }) => {
			const reads = body.indexOf("chartersFor(roster, tree,");
			if (reads === -1) {
				return [`${name} does not read its lenses from the tree it reads`];
			}
			// After the refusal, since a refused tree has no path to read
			// from. Absence is its own failure rather than a passing
			// comparison: indexOf hands back -1, which is less than every
			// position, so a deleted check used to read as a check that came
			// first.
			const guarded = body.indexOf('"refusal" in tree');
			if (guarded === -1) return [`${name} never checks the tree is readable`];
			return guarded < reads
				? []
				: [`${name} reads lenses before it knows the tree is readable`];
		});

		expect(wrong).toEqual([]);
		// And nothing reaches past the tree for a directory of its own.
		expect(source).not.toMatch(/chartersFor\(roster, (?!tree,)/);
		// Including the one hop between the sites and the library, which
		// the loop above cannot see and which took `process.cwd()` without
		// a murmur while every one of those sites was correct.
		expect(source).toMatch(/lensesFor\([\s\S]{0,200}?\btree,?\s*\)/);
	});
});
