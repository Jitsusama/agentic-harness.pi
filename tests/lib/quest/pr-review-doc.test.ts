import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendPrReviewRound,
	type ReviewDocFinding,
	renderPrReviewRound,
} from "../../../lib/internal/quest/pr-review-doc";
import { parseDocumentFrontMatter } from "../../../lib/quest";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pr-review-doc-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const fixedNow = () => new Date("2026-06-03T12:00:00Z");

const sampleFindings: ReviewDocFinding[] = [
	{
		id: 1,
		label: "issue",
		severity: "critical",
		subject: "Nil check missing",
		discussion: "The bar function dereferences a possibly-nil pointer.",
		location: {
			kind: "line",
			file: "pkg/foo/bar.go",
			start: 42,
			end: 45,
			side: "new",
		},
		agreement: { raisedBy: ["kelpie", "parrot"] },
	},
	{
		id: 2,
		label: "nitpick",
		subject: "Inconsistent naming",
		discussion: "fooHandler vs barHandler; pick one.",
		location: { kind: "file", file: "pkg/foo/bar.go" },
	},
];

describe("renderPrReviewRound", () => {
	it("renders a round with reviewers, finding count and details", () => {
		const md = renderPrReviewRound({
			roundNumber: 1,
			date: "2026-06-03",
			councilReviewerIds: ["kelpie", "parrot"],
			rawFindingsCount: 7,
			judgeFindings: sampleFindings,
		});
		expect(md).toContain("## Round 1 \u2014 2026-06-03");
		expect(md).toContain("Council reviewers: kelpie, parrot.");
		expect(md).toContain("Raw findings: 7. Judge consolidated to 2.");
		expect(md).toContain(
			"#### Finding 1 \u2014 issue: Nil check missing (critical)",
		);
		expect(md).toContain("Location: pkg/foo/bar.go:42-45 (new side).");
		expect(md).toContain("Raised by: kelpie, parrot.");
		expect(md).toContain("#### Finding 2 \u2014 nitpick: Inconsistent naming");
		expect(md).toContain("Location: pkg/foo/bar.go.");
	});

	it("renders the judge self-signal when provided", () => {
		const md = renderPrReviewRound({
			roundNumber: 2,
			date: "2026-06-04",
			councilReviewerIds: ["kelpie"],
			rawFindingsCount: 3,
			judgeFindings: sampleFindings.slice(0, 1),
			judgeSelfSignal: {
				confidence: "high",
				rationale: "Strong agreement across reviewers.",
			},
		});
		expect(md).toContain("Judge self-signal: high confidence.");
		expect(md).toContain("Strong agreement across reviewers.");
	});

	it("inlines critique entries grouped by finding", () => {
		const md = renderPrReviewRound({
			roundNumber: 1,
			date: "2026-06-03",
			councilReviewerIds: ["kelpie", "parrot"],
			rawFindingsCount: 5,
			judgeFindings: sampleFindings,
			critiques: [
				{
					findingId: 1,
					reviewerId: "parrot",
					position: "agree",
					rationale: "Reproduced locally.",
				},
				{
					findingId: 1,
					reviewerId: "kelpie",
					position: "qualify",
					rationale: "Only fires when foo is nil.",
				},
				{
					findingId: 2,
					reviewerId: "parrot",
					position: "disagree",
					rationale: "Naming is conventional in this package.",
				},
			],
		});
		expect(md).toContain("Critique:");
		expect(md).toContain("- parrot (agree): Reproduced locally.");
		expect(md).toContain("- kelpie (qualify): Only fires when foo is nil.");
		expect(md).toContain(
			"- parrot (disagree): Naming is conventional in this package.",
		);
	});

	it("handles an empty findings list", () => {
		const md = renderPrReviewRound({
			roundNumber: 1,
			date: "2026-06-03",
			councilReviewerIds: ["kelpie"],
			rawFindingsCount: 0,
			judgeFindings: [],
		});
		expect(md).toContain("Judge consolidated to 0.");
		expect(md).toContain("_No consolidated findings this round._");
	});

	it("renders global-location findings cleanly", () => {
		const md = renderPrReviewRound({
			roundNumber: 1,
			date: "2026-06-03",
			councilReviewerIds: ["kelpie"],
			rawFindingsCount: 1,
			judgeFindings: [
				{
					id: 1,
					label: "thought",
					subject: "PR is hard to navigate",
					discussion: "Consider splitting.",
					location: { kind: "global" },
				},
			],
		});
		expect(md).toContain("Location: PR-wide.");
	});
});

describe("appendPrReviewRound", () => {
	it("scaffolds a new doc on first call", () => {
		const result = appendPrReviewRound({
			sidequestDir: root,
			sidequestId: "QEST-20260601-AAAAAA",
			prSlug: "Shopify/world#123",
			date: "2026-06-03",
			councilReviewerIds: ["kelpie", "parrot"],
			rawFindingsCount: 4,
			judgeFindings: sampleFindings,
			now: fixedNow,
		});
		expect(result.isNew).toBe(true);
		expect(result.roundNumber).toBe(1);
		expect(result.docId).toMatch(/^RSCH-\d{8}-[A-Z0-9]{6}$/);
		expect(result.path).toContain("/research/");
		const text = readFileSync(result.path, "utf8");
		const parsed = parseDocumentFrontMatter(text);
		expect(parsed?.frontMatter.kind).toBe("research");
		expect(parsed?.frontMatter.quest).toBe("QEST-20260601-AAAAAA");
		expect(parsed?.frontMatter.id).toBe(result.docId);
		expect(text).toContain("# PR Review: Shopify/world#123");
		expect(text).toContain("## Round 1 \u2014 2026-06-03");
	});

	it("appends a new round to an existing doc", () => {
		const first = appendPrReviewRound({
			sidequestDir: root,
			sidequestId: "QEST-20260601-AAAAAA",
			prSlug: "Shopify/world#123",
			date: "2026-06-03",
			councilReviewerIds: ["kelpie"],
			rawFindingsCount: 2,
			judgeFindings: sampleFindings,
			now: fixedNow,
		});
		const second = appendPrReviewRound({
			sidequestDir: root,
			sidequestId: "QEST-20260601-AAAAAA",
			prSlug: "Shopify/world#123",
			date: "2026-06-04",
			councilReviewerIds: ["kelpie", "parrot"],
			rawFindingsCount: 3,
			judgeFindings: [sampleFindings[0]],
			now: fixedNow,
		});
		expect(second.isNew).toBe(false);
		expect(second.docId).toBe(first.docId);
		expect(second.roundNumber).toBe(2);
		const text = readFileSync(second.path, "utf8");
		expect(text).toContain("## Round 1 \u2014 2026-06-03");
		expect(text).toContain("## Round 2 \u2014 2026-06-04");
		// Round 1 details are preserved.
		expect(text).toContain("Inconsistent naming");
		const parsed = parseDocumentFrontMatter(text);
		expect(parsed?.frontMatter.updated).toBe("2026-06-04");
	});

	it("counts rounds in document order, not by reading the frontmatter", () => {
		// Create three rounds and confirm the counter walks.
		for (let i = 0; i < 3; i++) {
			appendPrReviewRound({
				sidequestDir: root,
				sidequestId: "QEST-20260601-AAAAAA",
				prSlug: "Shopify/world#5",
				date: `2026-06-0${i + 1}`,
				councilReviewerIds: ["kelpie"],
				rawFindingsCount: 1,
				judgeFindings: sampleFindings.slice(0, 1),
				now: fixedNow,
			});
		}
		const fourth = appendPrReviewRound({
			sidequestDir: root,
			sidequestId: "QEST-20260601-AAAAAA",
			prSlug: "Shopify/world#5",
			date: "2026-06-05",
			councilReviewerIds: ["kelpie"],
			rawFindingsCount: 1,
			judgeFindings: sampleFindings.slice(0, 1),
			now: fixedNow,
		});
		expect(fourth.roundNumber).toBe(4);
		const text = readFileSync(fourth.path, "utf8");
		expect(text).toContain("## Round 4 \u2014 2026-06-05");
	});
});
