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
	type ConformanceBar,
	hardestLevel,
	type Impact,
	orderFindings,
	tallyFindings,
} from "./axe.js";
import { count, renderVerdict, standingFor, type Verdict } from "./verdict.js";

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
/**
 * Where a tally stands against the standards, which is what the
 * mark at the top means.
 *
 * FAIL is reserved for a criterion that was actually violated.
 * Best practice is somebody's good advice, not a standard, and a
 * report that opened with FAIL because a page has two level-one
 * headings spends the word on an opinion. Anybody gating a build
 * on it then has to ignore it, and the one time it means a real
 * violation they will.
 *
 * So best-practice failures land with the undecided ones under
 * WARN, which keeps a single honest meaning for that mark: the
 * tool will not decide this one for you, either because nothing
 * could measure it or because whether it matters is a judgment
 * call. The headline always says which.
 */
function standardsPosition(tally: AxeTally): {
	failures: number;
	warnings: number;
} {
	return {
		failures: tally.wcag,
		warnings: tally.needsReview + tally.bestPractice,
	};
}

/**
 * Which bar this was judged against, and whether a lower one
 * would have been met.
 *
 * The bar has to be named or the report is unreadable: a page
 * built to AA, judged at AAA, reads as broken rather than as not
 * reaching for the enhanced level. And naming it is not enough on
 * its own. A reader whose only failures are AAA ones needs to be
 * told the page still meets AA, because the difference between
 * "non-conformant" and "conformant, short of enhanced" is the
 * difference between an emergency and a backlog item.
 */
function againstBar(
	findings: readonly A11yFinding[],
	bar: ConformanceBar | undefined,
): string {
	if (bar === undefined) return "";
	const failed = findings.filter((finding) => finding.kind === "violation");
	if (failed.length === 0) return ` Judged against ${bar}.`;
	const hardest = hardestLevel(failed);
	if (bar === "AAA" && hardest === "AAA") {
		return " Judged against AAA; every failure is a AAA one, so the page still meets AA.";
	}
	return ` Judged against ${bar}.`;
}

export function renderSummary(tally: AxeTally): string {
	if (tally.violations === 0 && tally.needsReview === 0) {
		return "Nothing failed.";
	}

	const parts: string[] = [];
	// Say outright when nothing broke a standard, because the mark
	// above now reads WARN and a reader deserves to know why before
	// the counts start.
	if (tally.wcag === 0 && tally.bestPractice > 0) {
		parts.push(
			`No WCAG criterion failed. ${count(
				tally.bestPractice,
				"best-practice rule",
			)} did, across ${count(tally.elements, "element")}.`,
		);
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

/**
 * Reported rules whose name shares a word with the one asked for.
 *
 * Rule names are hyphenated words, and the ways people get one
 * wrong nearly always keep a word: target-size for
 * target-is-big-enough, contrast for color-contrast. Matching on
 * whole words rather than on edit distance keeps an unrelated
 * rule out of a suggestion that is meant to be a short list.
 */
function nearestRules(
	asked: string,
	reported: readonly string[],
): readonly string[] {
	const words = new Set(asked.toLowerCase().split(/[^a-z0-9]+/i));
	words.delete("");
	return reported
		.filter((rule) =>
			rule
				.toLowerCase()
				.split(/[^a-z0-9]+/i)
				.some((word) => words.has(word)),
		)
		.slice(0, MAX_SUGGESTED_RULES);
}

/** How many near misses are a help rather than a second list. */
const MAX_SUGGESTED_RULES = 3;

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
	options: {
		readonly rule?: string;
		readonly measured?: string;
		/** The bar the audit was held to, when it was not the default. */
		readonly bar?: ConformanceBar;
	} = {},
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
		// A drill-down carries a verdict head like every other answer.
		// It used to return bare prose, and a caller that recovered the
		// standing by reading the first word then scored it a pass, so
		// a swept rule query reported PASS at every width while the
		// rule was failing at all of them.
		if (found.length === 0) {
			const reported = [...new Set(findings.map((finding) => finding.rule))];
			const names = reported.slice(0, MAX_LISTED_NODES).join(", ");
			// A clean page is a clean page, whatever was asked for.
			if (names === "") {
				return renderVerdict(
					{
						standing: "pass",
						headline:
							`Nothing was reported for '${options.rule}', and ` +
							"nothing failed.",
					},
					"",
				);
			}
			// On a page that did report, a name matching none of it is
			// two different answers wearing one face: the rule ran and
			// was clean, or the name is wrong. Nothing here can tell
			// them apart, and PASS picks the flattering one. Asked for
			// 'target-size', which is what axe calls this rule elsewhere
			// and what WCAG calls the criterion, a page failing ten
			// rules answered PASS with the failures a line below.
			const close = nearestRules(options.rule, reported);
			return renderVerdict(
				{
					standing: "warn",
					headline:
						`Nothing was reported for '${options.rule}'. It may ` +
						"have passed, or it may not be a rule name.",
					measured:
						(close.length === 0
							? ""
							: `Closest reported: ${close.join(", ")}. `) +
						`Reported: ${names}.`,
				},
				"",
			);
		}
		const ruleTally = tallyFindings(found);
		return renderVerdict(
			{
				standing: standingFor(standardsPosition(ruleTally)),
				headline: `${options.rule}: ${renderSummary(ruleTally)}`,
				...(options.measured === undefined
					? {}
					: { measured: options.measured }),
			},
			found.map(renderFinding).join("\n\n"),
		);
	}

	const index = renderIndex(findings);
	const verdict: Verdict = {
		standing: standingFor(standardsPosition(tally)),
		headline: `${renderSummary(tally)}${againstBar(findings, options.bar)}`,
		...(options.measured === undefined ? {} : { measured: options.measured }),
	};
	return renderVerdict(
		verdict,
		index === ""
			? ""
			: `${index}\n\nName a rule to see the elements and how to fix them.`,
	);
}
