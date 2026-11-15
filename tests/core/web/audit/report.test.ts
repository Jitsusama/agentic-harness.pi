/**
 * Reporting axe results: the summary, the index of rules, one
 * finding in full, and the whole audit with its verdict. The run
 * read here is a real axe run against a deliberately broken page.
 */

import { describe, expect, it } from "vitest";
import { readAxeRun, tallyFindings } from "../../../../lib/core/web/audit/axe.ts";
import {
	renderAudit,
	renderFinding,
	renderIndex,
	renderSummary,
} from "../../../../lib/core/web/audit/report.ts";
import { RUN } from "./axe-run.ts";

describe("renderSummary", () => {
	it("says nothing was found when nothing was", () => {
		expect(renderSummary(tallyFindings([]))).toContain("Nothing failed");
	});

	it("leads with rules, elements and severities", () => {
		const out = renderSummary(tallyFindings(readAxeRun(RUN)));
		expect(out).toContain("4 rules failed across 12 elements");
		expect(out).toContain("1 critical");
	});

	it("always separates WCAG from best practice", () => {
		const out = renderSummary(tallyFindings(readAxeRun(RUN)));
		expect(out).toContain("2 are WCAG criteria, 2 best practice");
	});

	it("reports what needs a person rather than burying it", () => {
		expect(renderSummary(tallyFindings(readAxeRun(RUN)))).toContain(
			"1 rule on 1 element needs a person to look",
		);
	});

	it("agrees with itself grammatically when a count is one", () => {
		// This line is the one every reader sees, so "1 rules failed"
		// is a small error in a conspicuous place.
		const single = tallyFindings(
			readAxeRun({
				violations: [
					{
						id: "solo",
						impact: "serious",
						tags: ["wcag2a", "wcag111"],
						nodes: [{}],
					},
				],
			}),
		);
		const out = renderSummary(single);
		expect(out).toContain("1 rule failed across 1 element");
		expect(out).toContain("1 is a WCAG criterion");
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

	it("opens with a verdict every check shares", () => {
		expect(renderAudit(findings, tally)).toMatch(/^FAIL/);
		expect(renderAudit([], tallyFindings([]))).toMatch(/^PASS/);
	});

	it("names the bar it judged against", () => {
		// Without this a reader cannot tell whether a failure is a
		// standard being broken or an enhanced target not being met.
		expect(renderAudit(findings, tally, { bar: "AA" })).toContain(
			"Judged against AA",
		);
	});

	it("says the page still meets AA when every failure is a AAA one", () => {
		// The whole reason AAA can be the default. A page built to AA
		// and judged at AAA would otherwise read as broken rather than
		// as conformant and short of enhanced, which is the difference
		// between an emergency and a backlog item.
		const enhancedOnly = readAxeRun({
			violations: [
				{
					id: "color-contrast-enhanced",
					impact: "serious",
					tags: ["wcag2aaa", "wcag146"],
					nodes: [{}],
				},
			],
		});

		const text = renderAudit(enhancedOnly, tallyFindings(enhancedOnly), {
			bar: "AAA",
		});

		expect(text).toContain("still meets AA");
	});

	it("does not claim AA is met when an AA rule failed too", () => {
		// The control. A page failing both is an AA failure, and saying
		// it still meets AA would be the most damaging thing this
		// report could get wrong.
		const both = readAxeRun({
			violations: [
				{
					id: "color-contrast-enhanced",
					impact: "serious",
					tags: ["wcag2aaa", "wcag146"],
					nodes: [{}],
				},
				{
					id: "color-contrast",
					impact: "serious",
					tags: ["wcag2aa", "wcag143"],
					nodes: [{}],
				},
			],
		});

		const text = renderAudit(both, tallyFindings(both), { bar: "AAA" });

		expect(text).not.toContain("still meets AA");
		expect(text).toContain("Judged against AAA");
	});

	it("says nothing about a bar when none was given", () => {
		expect(renderAudit(findings, tally)).not.toContain("Judged against");
	});

	it("warns rather than passes when only undecided results remain", () => {
		// A checker that turns its own uncertainty into approval is
		// worse than no checker.
		const unsure = readAxeRun({
			incomplete: [{ id: "color-contrast", impact: "serious", nodes: [{}] }],
		});
		expect(renderAudit(unsure, tallyFindings(unsure))).toMatch(/^WARN/);
	});

	it("says what it measured, so a clean pass is not a shrug", () => {
		const out = renderAudit([], tallyFindings([]), {
			measured: "Checked 340 elements against 91 rules.",
		});
		expect(out).toContain("340 elements");
	});

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
