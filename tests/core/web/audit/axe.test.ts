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
	ENHANCED_WCAG_RULES,
	EXPERIMENTAL_WCAG_RULES,
	enabledRules,
	hardestLevel,
	levelsOf,
	MAX_NODE_HTML,
	mergeFindings,
	readAxeRun,
	readResult,
	tallyFindings,
	withinBar,
} from "../../../../lib/core/web/audit/axe.ts";
import { renderAudit } from "../../../../lib/core/web/audit/report.ts";
import { RUN } from "./axe-run.ts";

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

describe("the experimental rules we switch on", () => {
	it("is exactly those the installed axe hides behind a WCAG tag", async () => {
		// Written down by name, so an axe upgrade that adds a rule
		// testing a criterion, or promotes one out of experimental,
		// is something to read rather than a silent change in what
		// this package audits. That has a cost either way: a new
		// hidden rule would go unasked, and a promoted one would be
		// reported as undecided long after axe made up its mind.
		const axe = await import("axe-core");
		const hidden = axe.default
			.getRules()
			.filter(
				(rule) =>
					rule.tags.includes("experimental") &&
					rule.tags.some((tag) => /^wcag\d/.test(tag)),
			)
			.map((rule) => rule.ruleId)
			.sort();

		expect([...EXPERIMENTAL_WCAG_RULES].sort()).toEqual(hidden);
	});

	it("knows every AAA rule the installed axe ships switched off", async () => {
		// Measured against axe 4.12.1: all three AAA-tagged rules are
		// disabled by default, so a run that does not name them checks
		// no AAA criterion at all. Pinned against the installed copy
		// because judging at AAA on the strength of rules that never
		// ran would report an untested page as an enhanced one.
		const axe = await import("axe-core");
		const enhanced = axe.default
			.getRules()
			.filter((rule) => rule.tags.some((tag) => /^wcag\d+a{3}$/.test(tag)))
			.map((rule) => rule.ruleId)
			.sort();

		expect([...ENHANCED_WCAG_RULES].sort()).toEqual(enhanced);
	});

	it("only asks for the enhanced rules at the enhanced bar", () => {
		const atAAA = Object.keys(enabledRules("AAA"));
		const atAA = Object.keys(enabledRules("AA"));

		for (const rule of ENHANCED_WCAG_RULES) {
			expect(atAAA).toContain(rule);
			expect(atAA).not.toContain(rule);
		}
		// The experimental rules carry A and AA criteria, so they are
		// asked for at every bar.
		for (const rule of EXPERIMENTAL_WCAG_RULES) {
			expect(atAA).toContain(rule);
		}
	});

	it("defaults to the enhanced bar", () => {
		expect(Object.keys(enabledRules())).toContain("color-contrast-enhanced");
	});
});

describe("withinBar", () => {
	it("asks for a level at or below the bar", () => {
		expect(withinBar(["A"], "AA"), "an A rule is asked for at AA").toBe(true);
		expect(withinBar(["AA"], "AA"), "an AA rule is asked for at AA").toBe(true);
		expect(withinBar(["AAA"], "AA"), "an AAA rule is not asked for at AA").toBe(
			false,
		);
		expect(withinBar(["AAA"], "AAA"), "an AAA rule is asked for at AAA").toBe(
			true,
		);
		expect(withinBar(["AA"], "A"), "an AA rule is not asked for at A").toBe(
			false,
		);
	});

	it("keeps a finding that carries no level at all", () => {
		// A best-practice rule was never the standard's to demand, so
		// no bar can excuse it.
		expect(withinBar([], "A"), "a rule with no level is kept even at A").toBe(
			true,
		);
	});

	it("keeps a rule spanning levels when the lower one is asked for", () => {
		expect(
			withinBar(["AA", "AAA"], "AA"),
			"a rule at AA and AAA is asked for at AA",
		).toBe(true);
	});
});

describe("hardestLevel", () => {
	it("names the least demanding level anything failed", () => {
		// A page failing both AA and AAA is an AA failure: fixing the
		// AAA one leaves it non-conformant either way.
		expect(hardestLevel([{ levels: ["AAA"] }, { levels: ["AA"] }])).toBe("AA");
	});

	it("says nothing when only AAA failed", () => {
		expect(hardestLevel([{ levels: ["AAA"] }])).toBe("AAA");
	});

	it("has no answer when nothing carries a level", () => {
		expect(hardestLevel([{ levels: [] }])).toBeUndefined();
	});
});

describe("the rule switches handed to axe", () => {
	it("asks axe to add them rather than to run only them", () => {
		// A runOnly tag list replaces the default set. Widening an
		// audit by narrowing it is the shape of a very quiet bug.
		const switches = enabledRules("AA");

		expect(Object.keys(switches).sort()).toEqual(
			[...EXPERIMENTAL_WCAG_RULES].sort(),
		);
		for (const rule of EXPERIMENTAL_WCAG_RULES) {
			expect(switches[rule]).toEqual({ enabled: true });
		}
	});

	it("adds the enhanced rules on top rather than replacing them", () => {
		const switches = enabledRules("AAA");

		expect(Object.keys(switches).sort()).toEqual(
			[...EXPERIMENTAL_WCAG_RULES, ...ENHANCED_WCAG_RULES].sort(),
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

	it("will not let an experimental rule decide against a page", () => {
		// axe ships five rules carrying real WCAG criteria switched
		// off, because it does not trust them to be right. Running
		// them is how 2.5.3 gets checked at all, but reporting what
		// they say as a decided failure would be borrowing an
		// authority axe itself declined to claim. This is the same
		// bargain the rest of the package makes: undecided is a
		// verdict, and a wrong accessibility finding costs more than
		// a missing one.
		const finding = readResult(
			{
				id: "label-content-name-mismatch",
				tags: ["wcag21a", "wcag253", "experimental"],
				nodes: [{ target: ["button"] }],
			},
			"violation",
		);

		expect(finding.kind).toBe("needs-review");
		// Still a WCAG rule with its criterion intact: the doubt is
		// about this rule's judgement, not about what it is testing.
		expect(finding.authority).toBe("wcag");
		expect(finding.criteria).toEqual(["2.5.3"]);
	});

	it("leaves a settled rule decided", () => {
		const finding = readResult(
			{ id: "image-alt", tags: ["wcag2a", "wcag111"], nodes: [] },
			"violation",
		);

		expect(finding.kind).toBe("violation");
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
		expect(merged.map((f) => f.rule)).not.toContain("heading-skips-level");
		expect(merged.map((f) => f.rule)).toContain("heading-order");
	});

	it("keeps a rule the primary set never reported", () => {
		const merged = mergeFindings(readAxeRun(RUN), ours, {
			"heading-skips-level": "heading-order",
		});
		expect(merged.map((f) => f.rule)).toContain("reference-resolves");
	});

	it("keeps a superseded rule when the primary set is absent", () => {
		// A capture audited without axe must not lose the check.
		const merged = mergeFindings([], ours, {
			"heading-skips-level": "heading-order",
		});
		expect(merged.map((f) => f.rule)).toContain("heading-skips-level");
	});

	it("orders findings the caller handed over unsorted", () => {
		// The layout rules build their list in rule order, so a
		// report that ordered only what came from axe put a serious
		// finding below a moderate one.
		const jumbled = [
			...readAxeRun({
				violations: [{ id: "z-moderate", impact: "moderate", nodes: [{}] }],
			}),
			...readAxeRun({
				violations: [{ id: "a-critical", impact: "critical", nodes: [{}] }],
			}),
		];
		const out = renderAudit(jumbled, tallyFindings(jumbled));
		expect(out.indexOf("a-critical")).toBeLessThan(out.indexOf("z-moderate"));
	});

	it("does not pass a rule name it never heard of", () => {
		// Asked for 'target-size', which is axe's own name for this
		// rule elsewhere and the name of the WCAG criterion, a page
		// failing ten rules answered PASS. A mistyped filter must not
		// read as a clean bill: nothing here can tell a rule that
		// passed from a rule that does not exist, and undecided is
		// what WARN is for.
		const real = readAxeRun({
			violations: [
				{ id: "target-is-big-enough", impact: "serious", nodes: [{}] },
			],
		});

		const out = renderAudit(real, tallyFindings(real), {
			rule: "target-size",
		});

		expect(out).toMatch(/^WARN/);
		expect(out).toContain("target-is-big-enough");
	});

	it("still passes a rule name when the page reported nothing at all", () => {
		// A clean page is a clean page, whatever was asked for.
		const out = renderAudit([], tallyFindings([]), { rule: "target-size" });

		expect(out).toMatch(/^PASS/);
	});

	it("spends FAIL on a criterion, not on advice", () => {
		// A page with two level-one headings is not a standards
		// failure, and opening with FAIL over it spends the word that
		// should mean a real violation. Anybody gating a build on the
		// mark then has to ignore it.
		// axe's real tags for this rule, which carries no wcag tag.
		const advice = readAxeRun({
			violations: [
				{
					id: "region",
					impact: "moderate",
					tags: ["cat.keyboard", "best-practice", "RGAAv4", "RGAA-9.2.1"],
					nodes: [{}, {}],
				},
			],
		});
		const out = renderAudit(advice, tallyFindings(advice));
		expect(out).toMatch(/^WARN/);
		expect(out).toContain("No WCAG criterion failed");
	});

	it("still spends FAIL on a real criterion", () => {
		// axe's real tags for image-alt: a level and a criterion.
		const real = readAxeRun({
			violations: [
				{
					id: "image-alt",
					impact: "critical",
					tags: ["cat.text-alternatives", "wcag2a", "wcag111", "section508"],
					nodes: [{}],
				},
			],
		});
		expect(renderAudit(real, tallyFindings(real))).toMatch(/^FAIL/);
	});

	it("treats a level tag with no criterion tag as a standard", () => {
		// Every rule axe ships carries both, so this is insurance
		// rather than a case seen in the wild. It is here because the
		// mark now turns on authority, and misreading a criterion as
		// advice would quietly downgrade a real violation to WARN.
		const levelOnly = readAxeRun({
			violations: [
				{ id: "invented", impact: "serious", tags: ["wcag2aa"], nodes: [{}] },
			],
		});
		expect(renderAudit(levelOnly, tallyFindings(levelOnly))).toMatch(/^FAIL/);
	});

	it("fails when a criterion and mere advice arrive together", () => {
		// The criterion decides it. Advice alongside must not soften
		// a real violation any more than it should manufacture one.
		const both = [
			...readAxeRun({
				violations: [
					{
						id: "image-alt",
						impact: "critical",
						tags: ["cat.text-alternatives", "wcag2a", "wcag111"],
						nodes: [{}],
					},
				],
			}),
			...readAxeRun({
				violations: [
					{
						id: "region",
						impact: "moderate",
						tags: ["cat.keyboard", "best-practice"],
						nodes: [{}],
					},
				],
			}),
		];
		expect(renderAudit(both, tallyFindings(both))).toMatch(/^FAIL/);
	});

	it("keeps PASS for a page with nothing to say about it", () => {
		expect(renderAudit([], tallyFindings([]))).toMatch(/^PASS/);
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
