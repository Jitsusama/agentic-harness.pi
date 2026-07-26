/**
 * Reporting accessibility findings without drowning the reader.
 *
 * Summary first, then one line per rule, then detail only when
 * asked for by rule name. A finding nobody can act on because it
 * arrived inside forty kilobytes of markup is not a finding.
 */

import {
	type A11yFinding,
	type AxeTally,
	type Impact,
	orderFindings,
} from "./axe.js";

/** Say a count with the noun that agrees with it. */
function count(many: number, one: string, plural = `${one}s`): string {
	return `${many} ${many === 1 ? one : plural}`;
}

/** How many elements to name under a rule before counting. */
export const MAX_LISTED_NODES = 5;

const IMPACT_ORDER: readonly Impact[] = [
	"critical",
	"serious",
	"moderate",
	"minor",
];

/**
 * The headline: what a person needs before deciding to read on.
 *
 * WCAG failures and best-practice advice are counted separately
 * and always, even when one of them is zero. The difference is
 * the difference between failing a standard and disagreeing with
 * a linter.
 */
export function renderSummary(tally: AxeTally): string {
	if (tally.violations === 0 && tally.needsReview === 0) {
		return "No accessibility violations found by axe.";
	}

	const parts: string[] = [];
	if (tally.violations > 0) {
		const severities = IMPACT_ORDER.filter(
			(impact) => tally.byImpact[impact] > 0,
		)
			.map((impact) => `${tally.byImpact[impact]} ${impact}`)
			.join(", ");
		parts.push(
			`${count(tally.violations, "rule")} failed across ` +
				`${count(tally.elements, "element")}: ${severities}.`,
		);
		parts.push(
			`${
				tally.wcag === 1
					? "1 is a WCAG criterion"
					: `${tally.wcag} are WCAG criteria`
			}, ${tally.bestPractice} best practice.`,
		);
	}
	if (tally.needsReview > 0) {
		parts.push(
			`${count(tally.needsReview, "rule")} on ` +
				`${count(tally.reviewElements, "element")} ` +
				`${tally.needsReview === 1 ? "needs" : "need"} a person to ` +
				"look: nothing could decide on its own.",
		);
	}
	return parts.join(" ");
}

/** One line per rule: enough to choose what to read. */
export function renderIndex(findings: readonly A11yFinding[]): string {
	if (findings.length === 0) return "";
	const lines: string[] = [];
	let heading: string | undefined;
	for (const finding of findings) {
		const group =
			finding.kind === "violation" ? "Failures" : "Needs a person to look";
		if (group !== heading) {
			if (heading !== undefined) lines.push("");
			lines.push(group);
			heading = group;
		}
		lines.push(`  ${describeRule(finding)}`);
	}
	return lines.join("\n");
}

function describeRule(finding: A11yFinding): string {
	const where =
		finding.criteria.length > 0
			? `WCAG ${finding.criteria.join(", ")}`
			: "best practice";
	const hits = count(finding.nodes.length, "element");
	return `${finding.impact.padEnd(8)} ${finding.rule.padEnd(28)} ${hits.padEnd(12)} ${where}`;
}

/** Everything known about one rule, for when it is asked about. */
export function renderFinding(finding: A11yFinding): string {
	const lines = [
		`${finding.rule}  (${finding.impact}, ${
			finding.criteria.length > 0
				? `WCAG ${finding.criteria.join(", ")}${
						finding.levels.length > 0
							? ` level ${finding.levels.join("/")}`
							: ""
					}`
				: "best practice"
		})`,
		finding.help,
	];
	if (finding.kind === "needs-review") {
		lines.push("axe could not decide this one; it needs a person to look.");
	}
	lines.push("");

	for (const node of finding.nodes.slice(0, MAX_LISTED_NODES)) {
		lines.push(`  ${node.selector}`);
		if (node.html) lines.push(`    ${node.html}`);
		for (const message of node.messages) lines.push(`    ${message}`);
	}
	if (finding.nodes.length > MAX_LISTED_NODES) {
		lines.push(
			`  ... and ${count(finding.nodes.length - MAX_LISTED_NODES, "more element")}`,
		);
	}
	if (finding.helpUrl) {
		lines.push("", finding.helpUrl);
	}
	return lines.join("\n");
}

/** The whole report, summary first. */
export function renderAudit(
	unordered: readonly A11yFinding[],
	tally: AxeTally,
	options: { readonly rule?: string } = {},
): string {
	// Ordered here rather than trusted from the caller. A report
	// that claims to lead with the worst thing found has to do so
	// however the findings were assembled: the layout rules build
	// their list in rule order, and reported a serious finding
	// below a moderate one until this was moved here.
	const findings = orderFindings(unordered);
	if (options.rule) {
		// A rule can be reported twice, once as a failure and once as
		// undecided: colour contrast does exactly this when some text
		// sits on a gradient. Showing only the first would hide the
		// half that most needs a person.
		const found = findings.filter((finding) => finding.rule === options.rule);
		if (found.length === 0) {
			const names = [...new Set(findings.map((finding) => finding.rule))]
				.slice(0, MAX_LISTED_NODES)
				.join(", ");
			return names === ""
				? `Nothing was reported for '${options.rule}', and nothing failed.`
				: `Nothing was reported for '${options.rule}'. Reported: ${names}.`;
		}
		return found.map(renderFinding).join("\n\n");
	}

	const summary = renderSummary(tally);
	const index = renderIndex(findings);
	if (index === "") return summary;
	return [
		summary,
		"",
		index,
		"",
		"Name a rule to see the elements and how to fix them.",
	].join("\n");
}
