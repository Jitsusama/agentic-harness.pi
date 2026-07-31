import { describe, expect, it } from "vitest";
import { explainDocumentFrontMatter } from "../../../lib/internal/quest/frontmatter.js";

/** A document whose stage is not one, which is the live case. */
const VERIFIED = [
	"---",
	"id: RSCH-20260618-C9CHTS",
	"kind: research",
	"quest: QEST-20260615-I4D0R3",
	"stage: verified",
	"updated: 2026-06-18",
	"---",
	"",
	"# Something",
].join("\n");

describe("why a document could not be read", () => {
	it("names the offending value and the vocabulary", () => {
		const said = explainDocumentFrontMatter(VERIFIED);

		expect(said).toHaveLength(1);
		expect(said[0]).toContain('"verified"');
		expect(said[0]).toContain("concluded");
	});

	it("is quiet about a document that reads fine", () => {
		expect(
			explainDocumentFrontMatter(VERIFIED.replace("verified", "concluded")),
		).toEqual([]);
	});

	it("reports every fault, not the first", () => {
		const broken = VERIFIED.replace("kind: research", "kind: memo").replace(
			"id: RSCH-20260618-C9CHTS",
			"id:",
		);

		expect(explainDocumentFrontMatter(broken).length).toBeGreaterThan(2);
	});

	it("says so when there is no front-matter at all", () => {
		expect(explainDocumentFrontMatter("# Just a heading")).toEqual([
			"it has no front-matter block",
		]);
	});
});
