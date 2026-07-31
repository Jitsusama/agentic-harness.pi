import { describe, expect, it } from "vitest";
import { standsAt } from "../../../lib/review/landing.js";

describe("standsAt", () => {
	it("says nothing when the backend said nothing", () => {
		// Absent means unreported, not clear to land. A backend with no view
		// on this must not be made to say the change is fine.
		expect(standsAt(undefined)).toBe("");
		expect(standsAt({})).toBe("");
	});

	it("names every blocker, not just the first", () => {
		// The whole point of not reducing this to a boolean. A change with
		// changes requested and a failing check needs two fixes, and being
		// told about one of them sends somebody back a second time.
		const said = standsAt({
			changesRequested: true,
			failingRequiredCheck: true,
		});

		expect(said).toContain("changes were requested");
		expect(said).toContain("a required check is failing");
	});

	it("passes the backend's own word through, since it may know more", () => {
		const said = standsAt({ reason: "draft", changesRequested: false });

		expect(said).toContain("draft");
	});

	it("does not repeat the backend's word when the flags already say it", () => {
		// `changes_requested` beside `changes were requested` is the same
		// sentence twice in two vocabularies.
		const said = standsAt({
			reason: "changes_requested",
			changesRequested: true,
		});

		expect(said).toContain("changes were requested");
		expect(said).not.toContain("changes_requested");
	});

	it("reports a conflict, which is the one nobody can fix by reviewing", () => {
		expect(standsAt({ conflicted: true })).toContain("conflicts with its base");
	});

	it("says it can land when the backend says so and nothing is in the way", () => {
		expect(standsAt({ reason: "mergeable", approved: true })).toContain(
			"can land",
		);
	});

	it("does not call an approved change landable while a check is failing", () => {
		// Approval is not the only gate, and a green-sounding sentence over a
		// red check is the worst thing this could say.
		const said = standsAt({ approved: true, failingRequiredCheck: true });

		expect(said).not.toContain("can land");
		expect(said).toContain("a required check is failing");
	});
});
