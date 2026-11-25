/**
 * Which looks are refused for what a change's host says of who wrote
 * it: every agent proposes under the person's own account, so a change
 * that account wrote never goes on his list.
 */

import { describe, expect, it } from "vitest";
import { authoredRefusal } from "../../../../lib/mesh/looks/own-changes.ts";

describe("refusing a look for who wrote its change", () => {
	it("refuses a change the signed-in account wrote, naming it", () => {
		expect(
			authoredRefusal({ by: "signed-in", author: "Jitsusama" }, "page"),
		).toMatch(/^Jitsusama wrote that change/);
	});

	it("refuses one its host couldn't say the author of, saying why", () => {
		expect(
			authoredRefusal({ by: "unknown", why: "gh is signed out" }, "diff"),
		).toContain("(gh is signed out)");
	});

	it("refuses a pull request look nothing answered for", () => {
		expect(authoredRefusal({ by: "unanswered" }, "pr")).toContain(
			"Nothing could say in time",
		);
	});

	it("lets up a page nothing answered for, which may be no change at all", () => {
		expect(authoredRefusal({ by: "unanswered" }, "page")).toBeUndefined();
	});

	it("lets up someone else's change, and a page no host claims", () => {
		expect(
			authoredRefusal({ by: "other", author: "someone" }, "pr"),
		).toBeUndefined();
		expect(authoredRefusal({ by: "no-change" }, "page")).toBeUndefined();
	});

	it("says what to do instead", () => {
		expect(authoredRefusal({ by: "signed-in", author: "me" }, "pr")).toContain(
			"review_offer",
		);
	});
});
