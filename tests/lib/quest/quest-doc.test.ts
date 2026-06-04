import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkboxProgress,
	extractCast,
	extractJourney,
	extractMentions,
	extractSectionParagraph,
	extractTitle,
	milestoneProgress,
	parseQuestDoc,
} from "../../../lib/internal/quest/quest-doc";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";

const SAMPLE_README = [
	"---",
	"id: QEST-20260603-AAA111",
	"kind: sidequest",
	"parent: null",
	"status: active",
	"priority: driving",
	"rank: 1",
	"started: 2026-06-03",
	"updated: 2026-06-03",
	"aliases:",
	"  - github-issue:shop/world#47281",
	"sessions: []",
	"---",
	"",
	"# Investigate the LFS lock 401",
	"",
	"## 📜 Summary",
	"",
	"Ahmad reported a 401 on LFS lock acquisition. We need to",
	"trace the auth path and find where the credential is",
	"dropped.",
	"",
	"More prose continues here.",
	"",
	"## 🧭 Purpose",
	"",
	"Without this fix, every LFS push fails for the affected",
	"users.",
	"",
	"## 🎭 Cast",
	"",
	"- **owner**: Joel Gerber. Coordinates the investigation.",
	"- **reviewer**: @xiao.li. Gates the auth changes.",
	"- **originator**: @ahmad.shaffer. Reported the 401 in",
	"  [Slack 2026-06-02](https://shopify.slack.com/archives/C0AJY0FLK8Q/p1778683833000200).",
	"",
	"## 🌄 Journey",
	"",
	"- **2026-06-03**: Created the sidequest from Ahmad's report.",
	"- **2026-06-04**: Reproduced locally with a stale auth token.",
	"",
	"## 🎯 Milestones",
	"",
	"- [x] Reproduce locally",
	"- [ ] Identify the dropped credential",
	"- [ ] Land the fix",
	"",
	"See also QEST-20260601-RELATE for context, and",
	"https://github.com/shop/world/pull/47282 for context.",
].join("\n");

beforeEach(() => {
	clearRefTypes();
	registerBuiltinRefTypes();
});
afterEach(() => clearRefTypes());

describe("parseQuestDoc", () => {
	it("returns the front-matter plus the body and title", () => {
		const doc = parseQuestDoc(SAMPLE_README);
		expect(doc?.title).toBe("Investigate the LFS lock 401");
		expect(doc?.frontMatter.id).toBe("QEST-20260603-AAA111");
		expect(doc?.body).toContain("## 📜 Summary");
	});

	it("returns undefined for a body without front-matter", () => {
		expect(parseQuestDoc("# bare body")).toBeUndefined();
	});
});

describe("section extraction", () => {
	it("extractTitle returns the H1", () => {
		expect(extractTitle("# A title\n\nbody")).toBe("A title");
	});

	it("extractSectionParagraph returns the first paragraph", () => {
		const doc = parseQuestDoc(SAMPLE_README);
		expect(extractSectionParagraph(doc?.body ?? "", "summary")).toContain(
			"Ahmad reported a 401",
		);
		// Second paragraph (More prose continues here) is
		// not included.
		expect(extractSectionParagraph(doc?.body ?? "", "summary")).not.toContain(
			"More prose",
		);
	});

	it("extractSectionParagraph returns undefined for absent sections", () => {
		expect(
			extractSectionParagraph(
				parseQuestDoc(SAMPLE_README)?.body ?? "",
				"spirit",
			),
		).toBeUndefined();
	});
});

describe("Cast extraction", () => {
	it("parses role-prefix bullets into structured entries", () => {
		const doc = parseQuestDoc(SAMPLE_README);
		const cast = extractCast(doc?.body ?? "");
		expect(cast.map((c) => c.role)).toEqual([
			"owner",
			"reviewer",
			"originator",
		]);
		expect(cast[0].subject).toBe("Joel Gerber");
		expect(cast[1].subject).toBe("@xiao.li");
		expect(cast[2].subject).toBe("@ahmad.shaffer");
	});
});

describe("Journey extraction", () => {
	it("parses dated entries", () => {
		const doc = parseQuestDoc(SAMPLE_README);
		const journey = extractJourney(doc?.body ?? "");
		expect(journey).toHaveLength(2);
		expect(journey[0].date).toBe("2026-06-03");
		expect(journey[0].prose).toContain("Created the sidequest");
	});
});

describe("milestoneProgress", () => {
	it("counts checked and total items", () => {
		const doc = parseQuestDoc(SAMPLE_README);
		expect(milestoneProgress(doc?.body ?? "")).toEqual({ total: 3, done: 1 });
	});

	it("returns zeroes when no milestones", () => {
		expect(milestoneProgress("no checkboxes here")).toEqual({
			total: 0,
			done: 0,
		});
	});
});

describe("checkboxProgress", () => {
	it("counts every checkbox in the body regardless of section", () => {
		const body = [
			"## Work",
			"- [x] First item",
			"- [x] Second item",
			"- [ ] Third item",
			"- [ ] Fourth item",
			"",
			"## Open Questions",
			"- [ ] Fifth item",
		].join("\n");
		expect(checkboxProgress(body)).toEqual({
			total: 5,
			done: 2,
			currentItem: "Third item",
		});
	});

	it("returns zeroes and no currentItem when the body has no checkboxes", () => {
		expect(checkboxProgress("no checkboxes here")).toEqual({
			total: 0,
			done: 0,
		});
	});

	it("omits currentItem when every checkbox is checked", () => {
		const body = ["## Work", "- [x] One", "- [x] Two"].join("\n");
		expect(checkboxProgress(body)).toEqual({ total: 2, done: 2 });
	});
});

describe("extractMentions", () => {
	it("captures bare IDs and refs in prose", () => {
		const doc = parseQuestDoc(SAMPLE_README);
		const mentions = extractMentions(doc?.body ?? "");
		expect(mentions.ids).toContain("QEST-20260601-RELATE");
		expect(mentions.refs).toContainEqual({
			type: "github-pr",
			value: "shop/world#47282",
		});
	});
});
