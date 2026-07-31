/**
 * Objecting to a publish.
 *
 * The seam exists so the working layer can be told something only the hosting
 * layer knows, without learning what a queue is. Two properties matter more than
 * the wording: silence must not block a push, and two objections must both
 * survive, since a summary drops whichever the reader most needed.
 */

import { describe, expect, it } from "vitest";
import { cautionsFrom, refusalFrom } from "../../../lib/work/objection.js";

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

	it("treats an objection that did not say as blocking", () => {
		// An author who did not think about it is more likely to have meant a
		// genuine objection than an aside.
		expect(refusalFrom([{ from: "github", reason: "no" }])).toBeDefined();
	});
});

describe("a caution, which decorates rather than decides", () => {
	// The distinction is not politeness. A backend can know it refuses to touch
	// a queued change and still be unable to say whether this one is queued;
	// blocking on that would refuse every push on the backend where the hazard
	// is worst, and a guard that refuses everything protects nothing once it is
	// switched off.
	const unsure = {
		from: "meteorite",
		blocking: false,
		reason: "cannot tell whether this one is queued",
		instead: "Cancel the merge first if it is.",
	};

	it("does not stop the push", () => {
		expect(refusalFrom([unsure])).toBeUndefined();
	});

	it("is still said, with what to do about it", () => {
		const said = cautionsFrom([unsure]);

		expect(said).toHaveLength(1);
		expect(said[0]).toContain("cannot tell");
		expect(said[0]).toContain("Cancel the merge");
	});

	it("keeps a blocker blocking when both arrive together", () => {
		// The one case where getting this wrong is expensive: a caution must not
		// dilute a real refusal that came in beside it.
		const both = [unsure, { from: "github", reason: "it is queued" }];

		expect(refusalFrom(both)).toContain("github");
		expect(refusalFrom(both)).not.toContain("meteorite");
		expect(cautionsFrom(both)).toHaveLength(1);
	});
});
