import { describe, expect, it } from "vitest";
import { placesAt } from "../../../../lib/internal/links/places.ts";

/** The place a click at `marker`'s first character lands on. */
function placeUnder(text: string, marker: string) {
	const index = text.indexOf(marker);
	if (index < 0) throw new Error(`${marker} is not in ${text}`);
	return placesAt(text, index)[0];
}

describe("the place a click falls in", () => {
	it("reads a URL whole, wherever in it the click lands", () => {
		const text = "see https://github.com/Jitsusama/x/pull/12 for it";
		expect(placeUnder(text, "pull")).toMatchObject({
			kind: "url",
			text: "https://github.com/Jitsusama/x/pull/12",
		});
	});

	it("leaves the sentence's punctuation out of a URL", () => {
		expect(placeUnder("(at https://example.com/a.)", "example")?.text).toBe(
			"https://example.com/a",
		);
	});

	it("keeps a URL's own brackets", () => {
		const text = "https://en.wikipedia.org/wiki/Kitty_(terminal).";
		expect(placeUnder(text, "wiki")?.text).toBe(
			"https://en.wikipedia.org/wiki/Kitty_(terminal)",
		);
	});

	it("reads an absolute path and one under home", () => {
		expect(placeUnder("wrote /home/joel/notes.md here", "notes")).toMatchObject(
			{ kind: "path", text: "/home/joel/notes.md" },
		);
		expect(placeUnder("open `~/src/x/README.md`", "src")).toMatchObject({
			kind: "path",
			text: "~/src/x/README.md",
		});
	});

	it("does not take a relative path or a URL's slashes for one", () => {
		expect(placeUnder("lib/links/places.ts", "links")).toBeUndefined();
		expect(
			placesAt("https://a.io/b", 9).map((place) => place.kind),
		).not.toContain("path");
	});

	it("reads owner/repo#N and a bare #N", () => {
		expect(
			placeUnder("merged Jitsusama/agentic-harness.pi#959.", "harness"),
		).toMatchObject({
			kind: "github-ref",
			text: "Jitsusama/agentic-harness.pi#959",
		});
		expect(placeUnder("in PR #959, then", "959")).toMatchObject({
			kind: "issue-number",
			text: "#959",
		});
	});

	it("reads a quest's id and a document's", () => {
		expect(placeUnder("on QEST-20261104-YJJEPK now", "YJJ")).toMatchObject({
			kind: "quest-id",
			text: "QEST-20261104-YJJEPK",
		});
		expect(placeUnder("(PLAN-20261104-SQBRTB)", "SQB")).toMatchObject({
			kind: "quest-id",
			text: "PLAN-20261104-SQBRTB",
		});
	});

	it("prefers the widest place, so a path naming an id is the path", () => {
		const text = "/q/QEST-20261104-YJJEPK/README.md";
		expect(placesAt(text, text.indexOf("YJJ")).map((p) => p.kind)).toEqual([
			"path",
			"quest-id",
		]);
	});

	it("finds nothing on a plain word or a space", () => {
		expect(placesAt("just some words", 6)).toEqual([]);
		expect(placesAt("a https://x.io", 1)).toEqual([]);
	});
});
