/**
 * Objecting to a publish.
 *
 * The seam exists so the working layer can be told something only the hosting
 * layer knows, without learning what a queue is. Two properties matter more than
 * the wording: silence must not block a push, and two objections must both
 * survive, since a summary drops whichever the reader most needed.
 */

import { describe, expect, it } from "vitest";
import { refusalFrom } from "../../../lib/work/objection.js";

describe("reading objections as a refusal", () => {
	it("says nothing when nobody objected", () => {
		// Silence is not approval, but it must not be a refusal either: a
		// session with no hosting provider loaded has to be able to publish.
		expect(refusalFrom([])).toBeUndefined();
	});

	it("names who objected and why", () => {
		const said = refusalFrom([
			{
				from: "meteorite",
				reason: "This change is queued to merge, and pushing ejects it.",
				instead: "Cancel the merge first.",
			},
		]);

		expect(said).toContain("meteorite");
		expect(said).toContain("queued to merge");
		expect(said).toContain("Cancel the merge first");
	});

	it("keeps every objection when several systems object", () => {
		// Two systems objecting for two reasons is a fact about the push, not a
		// formatting problem to be summarized away.
		const said = refusalFrom([
			{ from: "meteorite", reason: "queued to merge" },
			{ from: "github", reason: "waiting on checks" },
		]);

		expect(said).toContain("meteorite");
		expect(said).toContain("github");
		expect(said).toContain("queued to merge");
		expect(said).toContain("waiting on checks");
	});

	it("does not invent an alternative when none was given", () => {
		const said = refusalFrom([{ from: "github", reason: "it is queued" }]);

		expect(said).toBe("github says not to publish this yet. it is queued");
	});
});
