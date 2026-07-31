import { describe, expect, it } from "vitest";
import { chooseTree, treeInPlay } from "../../../lib/work/inplay.js";

describe("treeInPlay", () => {
	it("uses the only tree held", () => {
		const answer = treeInPlay(undefined, ["worktree-fix-410"]);

		expect("key" in answer && answer.key).toBe("worktree-fix-410");
	});

	it("never second-guesses a name, even one that matches nothing", () => {
		// A typo reported beats a typo redirected to whatever else is open, and
		// the actions this feeds include committing and force-pushing.
		const answer = treeInPlay("typo", ["worktree-fix-410"]);

		expect("key" in answer && answer.key).toBe("typo");
	});

	it("asks when several are held, rather than picking the newest", () => {
		// The change version resolves this by recency, because attaching a change
		// states an intent. Holding two trees states nothing.
		const answer = treeInPlay(undefined, ["one", "two"]);

		expect("candidates" in answer && answer.candidates).toEqual(["one", "two"]);
	});

	it("asks when none are held", () => {
		expect("candidates" in treeInPlay(undefined, [])).toBe(true);
	});
});

describe("chooseTree", () => {
	it("says how to get a tree when none is held", () => {
		expect(chooseTree([])).toContain("work tree");
	});

	it("names what is held, so a typo becomes a correction", () => {
		const said = chooseTree(["one", "two"]);

		expect(said).toContain("one, two");
		expect(said).toContain("2 are held");
	});
});
