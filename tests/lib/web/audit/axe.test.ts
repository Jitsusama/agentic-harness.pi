/**
 * Reading axe results.
 *
 * The fixtures are lifted verbatim from a real axe 4.12 run
 * against a deliberately broken page, tag lists and all, rather
 * than shortened to what the code happens to look at.
 */

import { describe, expect, it } from "vitest";
import {
	authorityOf,
	criteriaOf,
	levelsOf,
	MAX_NODE_HTML,
	mergeFindings,
	type RawAxeRun,
	readAxeRun,
	readResult,
	tallyFindings,
} from "../../../../lib/web/audit/axe.js";
import {
	renderAudit,
	renderFinding,
	renderIndex,
	renderSummary,
} from "../../../../lib/web/audit/report.js";

/** An axe run against a page with a dozen planted faults. */
const RUN: RawAxeRun = {
	violations: [
		{
			id: "image-alt",
			impact: "critical",
			tags: ["cat.text-alternatives", "wcag2a", "wcag111", "EN-301-549"],
			description: "Ensure <img> elements have alternate text",
			help: "Images must have alternative text",
			helpUrl: "https://dequeuniversity.com/rules/axe/4.12/image-alt",
			nodes: [
				{
					html: '<img src="/logo.png">',
					target: ["img"],
					impact: "critical",
					any: [{ message: "Element does not have an alt attribute" }],
					all: [],
					none: [],
				},
			],
		},
		{
			id: "color-contrast",
			impact: "serious",
			tags: ["cat.color", "wcag2aa", "wcag143"],
			help: "Elements must meet minimum colour contrast ratio thresholds",
			nodes: [
				{
					html: '<p class="faint">Faint text nobody can read</p>',
					target: [".faint"],
					any: [
						{
							message:
								"Element has insufficient colour contrast of 1.62 (foreground #bbbbbb, background #ffffff)",
						},
					],
				},
			],
		},
		{
			id: "heading-order",
			impact: "moderate",
			tags: ["cat.semantics", "best-practice"],
			help: "Heading levels should only increase by one",
			nodes: [{ html: "<h4>Skipped two levels</h4>", target: ["h4"], any: [] }],
		},
		{
			id: "region",
			impact: "moderate",
			tags: ["cat.keyboard", "best-practice"],
			help: "All page content should be contained by landmarks",
			nodes: Array.from({ length: 9 }, (_, index) => ({
				html: `<p>block ${index}</p>`,
				target: [`p:nth-child(${index + 1})`],
				any: [{ message: "Some page content is not contained by landmarks" }],
			})),
		},
	],
	incomplete: [
		{
			id: "color-contrast",
			impact: "serious",
			tags: ["cat.color", "wcag2aa", "wcag143"],
			help: "Elements must meet minimum colour contrast ratio thresholds",
			nodes: [
				{
					html: '<p class="grad">Text over a gradient</p>',
					target: [".grad"],
					any: [
						{
							message:
								"Element's background colour could not be determined due to a background gradient",
						},
					],
				},
			],
		},
	],
};

describe("criteriaOf", () => {
	it("reads a criterion tag as its dotted number", () => {
		expect(criteriaOf(["wcag412"])).toEqual(["4.1.2"]);
		expect(criteriaOf(["wcag143"])).toEqual(["1.4.3"]);
	});

	it("reads a two digit third part, as 1.4.11 has", () => {
		expect(criteriaOf(["wcag1411"])).toEqual(["1.4.11"]);
	});

	it("ignores the level tags, which are not criteria", () => {
		expect(criteriaOf(["wcag2a", "wcag2aa", "wcag21aa"])).toEqual([]);
	});

	it("ignores other standards, which are noise to a WCAG question", () => {
		expect(criteriaOf(["EN-301-549", "EN-9.4.1.2", "TTv5", "RGAAv4"])).toEqual(
			[],
		);
	});
});

describe("levelsOf", () => {
	it("reads A and AA from the level tags", () => {
		expect(levelsOf(["wcag2a", "wcag21aa"])).toEqual(["A", "AA"]);
	});

	it("says nothing for a best practice rule", () => {
		expect(levelsOf(["cat.semantics", "best-practice"])).toEqual([]);
	});
});

describe("authorityOf", () => {
	it("calls a rule with a criterion a WCAG rule", () => {
		expect(authorityOf(["wcag2a", "wcag111"])).toBe("wcag");
	});

	it("calls a rule with no criterion best practice", () => {
		// This distinction is the difference between failing a
		// standard and disagreeing with a linter.
		expect(authorityOf(["cat.semantics", "best-practice"])).toBe(
			"best-practice",
		);
	});
});

describe("readResult", () => {
	const first = RUN.violations?.[0];

	it("keeps the rule, impact and help", () => {
		if (!first) throw new Error("fixture lost its first violation");
		const finding = readResult(first, "violation");
		expect(finding.rule).toBe("image-alt");
		expect(finding.impact).toBe("critical");
		expect(finding.criteria).toEqual(["1.1.1"]);
	});

	it("takes the selector from the target", () => {
		if (!first) throw new Error("fixture lost its first violation");
		expect(readResult(first, "violation").nodes[0]?.selector).toBe("img");
	});

	it("joins a frame path rather than dropping it", () => {
		const finding = readResult(
			{ id: "x", nodes: [{ target: [["iframe#a", "button"]] }] },
			"violation",
		);
		expect(finding.nodes[0]?.selector).toBe("iframe#a >> button");
	});

	it("says so plainly when a node has no location", () => {
		const finding = readResult({ id: "x", nodes: [{}] }, "violation");
		expect(finding.nodes[0]?.selector).toBe("(unlocated)");
	});

	it("gathers the messages from all three check buckets", () => {
		const finding = readResult(
			{
				id: "x",
				nodes: [
					{ any: [{ message: "one" }], all: [{ message: "two" }], none: [] },
				],
			},
			"violation",
		);
		expect(finding.nodes[0]?.messages).toEqual(["one", "two"]);
	});

	it("does not repeat the same message twice", () => {
		const finding = readResult(
			{
				id: "x",
				nodes: [{ any: [{ message: "same" }], all: [{ message: "same" }] }],
			},
			"violation",
		);
		expect(finding.nodes[0]?.messages).toEqual(["same"]);
	});

	it("falls back to the summary when no check spoke", () => {
		const finding = readResult(
			{ id: "x", nodes: [{ failureSummary: "Fix all of the following" }] },
			"violation",
		);
		expect(finding.nodes[0]?.messages[0]).toContain("Fix all");
	});

	it("clips long markup and flattens its whitespace", () => {
		const finding = readResult(
			{ id: "x", nodes: [{ html: `<div>\n  ${"y".repeat(400)}</div>` }] },
			"violation",
		);
		const { html } = finding.nodes[0] ?? { html: "" };
		expect(html.length).toBeLessThanOrEqual(MAX_NODE_HTML + 3);
		expect(html).not.toContain("\n");
	});

	it("treats an unknown impact as the least of them", () => {
		expect(readResult({ id: "x", impact: null }, "violation").impact).toBe(
			"minor",
		);
	});
});

describe("readAxeRun", () => {
	const findings = readAxeRun(RUN);

	it("reads violations and incomplete results together", () => {
		expect(findings).toHaveLength(5);
	});

	it("marks the incomplete ones as needing a person", () => {
		const review = findings.filter(
			(finding) => finding.kind === "needs-review",
		);
		expect(review).toHaveLength(1);
		expect(review[0]?.rule).toBe("color-contrast");
	});

	it("puts what is known broken before what might be", () => {
		expect(findings.at(-1)?.kind).toBe("needs-review");
	});

	it("leads with the worst thing found", () => {
		expect(findings[0]?.rule).toBe("image-alt");
		expect(findings[0]?.impact).toBe("critical");
	});
});

describe("mergeFindings", () => {
	const ours = readAxeRun({
		violations: [
			{ id: "heading-skips-level", impact: "moderate", nodes: [{}] },
			{ id: "reference-resolves", impact: "critical", nodes: [{}] },
		],
	});

	it("drops a rule the primary set already reported by name", () => {
		const merged = mergeFindings(readAxeRun(RUN), ours);
		expect(
			merged.filter((finding) => finding.rule === "heading-order"),
		).toHaveLength(1);
	});

	it("drops a rule superseded under a different name", () => {
		// The overlap is invisible from the names alone, which is
		// why the map exists: axe calls this heading-order.
		const merged = mergeFindings(readAxeRun(RUN), ours, {
			"heading-skips-level": "heading-order",
		});
		expect(merged.some((f) => f.rule === "heading-skips-level")).toBe(false);
		expect(merged.some((f) => f.rule === "heading-order")).toBe(true);
	});

	it("keeps a rule the primary set never reported", () => {
		const merged = mergeFindings(readAxeRun(RUN), ours, {
			"heading-skips-level": "heading-order",
		});
		expect(merged.some((f) => f.rule === "reference-resolves")).toBe(true);
	});

	it("keeps a superseded rule when the primary set is absent", () => {
		// A capture audited without axe must not lose the check.
		const merged = mergeFindings([], ours, {
			"heading-skips-level": "heading-order",
		});
		expect(merged.some((f) => f.rule === "heading-skips-level")).toBe(true);
	});

	it("interleaves both sets by severity rather than by origin", () => {
		const merged = mergeFindings(readAxeRun(RUN), ours);
		const impacts = merged
			.filter((finding) => finding.kind === "violation")
			.map((finding) => finding.impact);
		expect(impacts).toEqual([...impacts].sort(bySeverity));
	});
});

const ORDER = ["critical", "serious", "moderate", "minor"];
const bySeverity = (a: string, b: string) =>
	ORDER.indexOf(a) - ORDER.indexOf(b);

describe("tallyFindings", () => {
	const tally = tallyFindings(readAxeRun(RUN));

	it("counts rules and elements separately", () => {
		// Four rules failed, but across twelve elements: nine of them
		// one rule. Reporting only rules would understate the work.
		expect(tally.violations).toBe(4);
		expect(tally.elements).toBe(12);
	});

	it("does not let an undecided element inflate the failure count", () => {
		// The gradient paragraph has not been shown to be broken.
		expect(tally.elements).toBe(12);
		expect(tally.reviewElements).toBe(1);
	});

	it("counts WCAG failures apart from best practice ones", () => {
		expect(tally.wcag).toBe(2);
		expect(tally.bestPractice).toBe(2);
	});

	it("does not count a needs-review result as a violation", () => {
		expect(tally.needsReview).toBe(1);
		expect(tally.byImpact.serious).toBe(1);
	});
});

describe("renderSummary", () => {
	it("says nothing was found when nothing was", () => {
		expect(renderSummary(tallyFindings([]))).toContain("No accessibility");
	});

	it("leads with rules, elements and severities", () => {
		const out = renderSummary(tallyFindings(readAxeRun(RUN)));
		expect(out).toContain("4 rules failed across 12 elements");
		expect(out).toContain("1 critical");
	});

	it("always separates WCAG from best practice", () => {
		const out = renderSummary(tallyFindings(readAxeRun(RUN)));
		expect(out).toContain("2 are WCAG criteria, 2 are best practice");
	});

	it("reports what needs a person rather than burying it", () => {
		expect(renderSummary(tallyFindings(readAxeRun(RUN)))).toContain(
			"1 rules on 1 elements need a person to look",
		);
	});
});

describe("renderIndex", () => {
	const out = renderIndex(readAxeRun(RUN));

	it("gives one line per rule, with how many elements each hit", () => {
		expect(out).toContain("image-alt");
		expect(out).toContain("1 element");
		expect(out).toContain("9 elements");
	});

	it("separates the failures from what needs review", () => {
		expect(out).toContain("Failures");
		expect(out).toContain("Needs a person to look");
	});

	it("quotes the criterion rather than only the rule name", () => {
		expect(out).toContain("WCAG 1.1.1");
	});

	it("says best practice where there is no criterion", () => {
		expect(out).toContain("best practice");
	});
});

describe("renderFinding", () => {
	const contrast = readAxeRun(RUN).find(
		(finding) => finding.rule === "color-contrast",
	);

	it("names the elements and what is wrong with each", () => {
		if (!contrast) throw new Error("fixture lost the contrast rule");
		const out = renderFinding(contrast);
		expect(out).toContain(".faint");
		expect(out).toContain("insufficient colour contrast");
	});

	it("counts the tail rather than listing every element", () => {
		const region = readAxeRun(RUN).find((finding) => finding.rule === "region");
		if (!region) throw new Error("fixture lost the region rule");
		expect(renderFinding(region)).toContain("and 4 more elements");
	});

	it("says outright when axe declined to decide", () => {
		const review = readAxeRun(RUN).find(
			(finding) => finding.kind === "needs-review",
		);
		if (!review) throw new Error("fixture lost the incomplete result");
		expect(renderFinding(review)).toContain("needs a person to look");
	});
});

describe("renderAudit", () => {
	const findings = readAxeRun(RUN);
	const tally = tallyFindings(findings);

	it("stays short enough to read at a glance", () => {
		const out = renderAudit(findings, tally);
		// The raw run this came from is 54 KB.
		expect(out.length).toBeLessThan(1500);
	});

	it("tells the reader how to get the detail", () => {
		expect(renderAudit(findings, tally)).toContain("Name a rule");
	});

	it("shows both halves of a rule reported twice", () => {
		// Colour contrast fails some text and cannot judge other
		// text on the same page. Showing only the failure would hide
		// the half that most needs a person to look at it.
		const out = renderAudit(findings, tally, { rule: "color-contrast" });
		expect(out).toContain(".faint");
		expect(out).toContain(".grad");
		expect(out).toContain("needs a person to look");
	});

	it("gives one rule in full when asked for it", () => {
		const out = renderAudit(findings, tally, { rule: "image-alt" });
		expect(out).toContain("alt attribute");
		expect(out).not.toContain("Name a rule");
	});

	it("lists what was reported when asked for a rule that was not", () => {
		const out = renderAudit(findings, tally, { rule: "nonsense" });
		expect(out).toContain("image-alt");
	});

	it("does not claim a clean page when asked about a rule on one", () => {
		const out = renderAudit([], tallyFindings([]), { rule: "image-alt" });
		expect(out).toContain("nothing failed");
	});
});
