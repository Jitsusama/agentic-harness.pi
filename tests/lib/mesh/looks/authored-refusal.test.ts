/**
 * Which looks are refused for what a change's host says of who wrote
 * it: every agent proposes under the person's own account, so a change
 * that account wrote never goes on his list.
 */

import { describe, expect, it } from "vitest";
import { authoredRefusal } from "../../../../lib/mesh/looks/own-changes.ts";

const PR = "https://github.com/jitsusama/agentic-harness.pi/pull/2188";

describe("refusing a look for who wrote its change", () => {
	it("refuses a change the signed-in account wrote, naming it", () => {
		expect(
			authoredRefusal({ by: "signed-in", author: "Jitsusama" }, PR),
		).toMatch(/^Jitsusama wrote that change/);
	});

	it("refuses one its host couldn't say the author of, saying why", () => {
		expect(
			authoredRefusal({ by: "unknown", why: "gh is signed out" }, PR),
		).toContain("(gh is signed out)");
	});

	it.each([
		PR,
		`${PR}/files`,
		`${PR}.diff`,
		"https://delta.shopify.io/shop/world/pull/12",
	])(
		"refuses %s when nothing answered, whatever kind the look is",
		(target) => {
			expect(authoredRefusal({ by: "unanswered" }, target)).toContain(
				"Nothing could say in time",
			);
		},
	);

	it("lets up a page nothing answered for that names no change", () => {
		expect(
			authoredRefusal({ by: "unanswered" }, "https://example.com/docs/a"),
		).toBeUndefined();
	});

	it("lets up someone else's change, and a page no host claims", () => {
		expect(
			authoredRefusal({ by: "other", author: "someone" }, PR),
		).toBeUndefined();
		expect(authoredRefusal({ by: "no-change" }, PR)).toBeUndefined();
	});

	it("tells a session sure of the author to review its own change", () => {
		expect(authoredRefusal({ by: "signed-in", author: "me" }, PR)).toContain(
			"review_offer",
		);
	});

	it.each([
		{ by: "unknown", why: "no viewer" } as const,
		{ by: "unanswered" } as const,
	])("names a way to reach him about a colleague's change when $by", (said) => {
		const refused = authoredRefusal(said, PR) ?? "";
		expect(refused).toContain("If someone else wrote it");
		expect(refused).toContain("mesh_send to person");
		expect(refused).not.toContain("The person reviews no change");
	});
});
