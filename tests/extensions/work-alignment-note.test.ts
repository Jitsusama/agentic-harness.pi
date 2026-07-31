/**
 * What a shape change says about the commits it did not move.
 *
 * Every stack verb records where a branch should sit without replaying anything, so
 * every one of them can leave the record and the commits disagreeing. Only reorder
 * ever mentioned it, unconditionally, which is a warning that cries wolf on the
 * reorder needing no replay at all and names no branches when there is one.
 */

import { describe, expect, it } from "vitest";
import { alignmentNote } from "../../extensions/work-integration/tools/stack.js";

describe("the note after a shape change", () => {
	it("names what is out of step, rather than warning in general", () => {
		const said = alignmentNote({ drifted: ["c"], undecided: [] }).join("\n");

		expect(said).toContain("c");
		expect(said).toContain("Restack");
	});

	it("says several in one sentence, and agrees with itself about number", () => {
		const said = alignmentNote({ drifted: ["b", "c"], undecided: [] }).join(
			"\n",
		);

		expect(said).toContain("b, c are not sitting on their parent");
	});

	it("uses the singular for one branch", () => {
		const said = alignmentNote({ drifted: ["c"], undecided: [] }).join("\n");

		expect(said).toContain("c is not sitting on its parent");
	});

	it("says so when the commits already match", () => {
		// The case reorder used to warn about anyway. A tool that always warns is a
		// tool whose warning carries nothing.
		const said = alignmentNote({ drifted: [], undecided: [] }).join("\n");

		expect(said).toContain("nothing to replay");
		expect(said).not.toContain("Restack to");
	});

	it("stays quiet when it could not judge everything", () => {
		// A root cannot be judged without a trunk to judge it against, and
		// "nothing to do" is not a thing to say about a question never answered.
		const said = alignmentNote({ drifted: [], undecided: ["a"] }).join("\n");

		expect(said).toBe("");
	});

	it("still warns about what it did judge, even when something was undecided", () => {
		const said = alignmentNote({ drifted: ["c"], undecided: ["a"] }).join("\n");

		expect(said).toContain("c");
	});
});
