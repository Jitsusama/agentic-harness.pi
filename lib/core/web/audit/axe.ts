/**
 * Reading axe-core's results.
 *
 * axe is the WCAG baseline here: a mature, widely trusted rule
 * set that there is no reason to reimplement. What it needs is
 * translating, for two reasons.
 *
 * The first is size. A thirteen element test page produces 54 KB
 * of JSON, and a real application produces far more, most of it
 * repeated rule metadata and full outerHTML for every node. Read
 * whole, it would crowd out the answer it was fetched to give.
 *
 * The second is that axe draws a distinction people routinely
 * lose, and it is worth preserving loudly. Some of its rules are
 * WCAG success criteria and some are best practice, and a report
 * that mixes them tells somebody their page fails a standard
 * when it does not. Incomplete results matter for the same
 * reason in reverse: axe declines to judge text over a gradient,
 * and turning that silence into a pass is how a tool starts
 * lying.
 */

/** One check axe ran against one element. */
export interface RawAxeNode {
	readonly html?: string;
	readonly target?: readonly (string | readonly string[])[];
	readonly impact?: string | null;
	readonly failureSummary?: string;
	readonly any?: readonly { readonly message?: string }[];
	readonly all?: readonly { readonly message?: string }[];
	readonly none?: readonly { readonly message?: string }[];
}

/** One rule axe reported on. */
export interface RawAxeResult {
	readonly id: string;
	readonly impact?: string | null;
	readonly tags?: readonly string[];
	readonly description?: string;
	readonly help?: string;
	readonly helpUrl?: string;
	readonly nodes?: readonly RawAxeNode[];
}

/** What axe.run resolves to. */
export interface RawAxeRun {
	readonly violations?: readonly RawAxeResult[];
	readonly incomplete?: readonly RawAxeResult[];
	readonly passes?: readonly RawAxeResult[];
	readonly inapplicable?: readonly RawAxeResult[];
}

/** How badly a finding bites, in axe's vocabulary. */
export type Impact = "critical" | "serious" | "moderate" | "minor";

/** Whether a finding is a standard failing or an opinion. */
export type Authority = "wcag" | "best-practice";

/**
 * The experimental axe rules that test a real WCAG criterion.
 *
 * axe ships these switched off because it does not trust them to
 * be right, which is its call to make about its own rules. But
 * off means never asked, and for 2.5.3 there is no other rule to
 * ask: leaving the default alone means that criterion is not
 * covered at all, while the report says the page passed the
 * standard. Silence read as a pass is the failure this package
 * cares most about.
 *
 * They are switched on and their findings come back as needing a
 * person, so axe's doubt travels with them rather than being
 * dropped on the floor.
 *
 * The list is checked against the installed axe by a test, so an
 * upgrade that adds or retires one is a failure to read rather
 * than a silent change in what gets audited.
 */
export const EXPERIMENTAL_WCAG_RULES: readonly string[] = [
	"css-orientation-lock",
	"label-content-name-mismatch",
	"p-as-heading",
	"table-fake-caption",
	"td-has-header",
];

/**
 * Which conformance level an audit is being held to.
 *
 * The levels nest: everything A demands, AA demands too, and AAA
 * demands all of it. So a bar is a ceiling on what gets asked,
 * not a slice.
 */
export type ConformanceBar = "A" | "AA" | "AAA";

/** How far each bar reaches, for comparing one against another. */
const BAR_REACH: Record<ConformanceBar, number> = { A: 1, AA: 2, AAA: 3 };

/**
 * The AAA rules axe ships switched off.
 *
 * Measured against axe 4.12.1: exactly three rules carry a AAA
 * tag and every one of them is disabled by default, so a run that
 * does not name them checks no AAA criterion at all. Judging at
 * AAA without switching these on would report a page as meeting
 * the enhanced bar on the strength of never having tested it.
 *
 * Checked against the installed axe by a test, like the
 * experimental list, so an upgrade that adds or retires one is a
 * failure to read rather than a silent gap.
 */
export const ENHANCED_WCAG_RULES: readonly string[] = [
	"color-contrast-enhanced",
	"identical-links-same-purpose",
	"meta-refresh-no-exceptions",
];

/**
 * Whether a finding is something the chosen bar actually asks for.
 *
 * A finding carrying no level is a best-practice rule rather than
 * a conformance claim, and those are always reported: they were
 * never the standard's to demand, so a bar cannot excuse them.
 */
export function withinBar(
	levels: readonly string[],
	bar: ConformanceBar,
): boolean {
	if (levels.length === 0) return true;
	return levels.some((level) => {
		const reach = BAR_REACH[level as ConformanceBar];
		return reach !== undefined && reach <= BAR_REACH[bar];
	});
}

/** The strictest level any of these findings failed. */
export function hardestLevel(
	findings: readonly { readonly levels: readonly string[] }[],
): ConformanceBar | undefined {
	let hardest: ConformanceBar | undefined;
	for (const finding of findings) {
		for (const level of finding.levels) {
			const bar = level as ConformanceBar;
			if (BAR_REACH[bar] === undefined) continue;
			if (hardest === undefined || BAR_REACH[bar] < BAR_REACH[hardest]) {
				hardest = bar;
			}
		}
	}
	return hardest;
}

/** Whether axe decided, or declined to. */
export type FindingKind = "violation" | "needs-review";

/** One element that failed a rule. */
export interface FindingNode {
	/** A CSS selector that reaches the element. */
	readonly selector: string;
	/** The element's own markup, clipped. */
	readonly html: string;
	/** What specifically was wrong with this one. */
	readonly messages: readonly string[];
}

/** One accessibility finding, ready to report. */
export interface A11yFinding {
	readonly rule: string;
	readonly kind: FindingKind;
	readonly impact: Impact;
	readonly authority: Authority;
	/** WCAG criteria this rule maps to, e.g. 1.4.3. */
	readonly criteria: readonly string[];
	/** The conformance levels involved, e.g. AA. */
	readonly levels: readonly string[];
	readonly help: string;
	readonly helpUrl?: string;
	readonly nodes: readonly FindingNode[];
}

/** How much markup to keep per node. */
export const MAX_NODE_HTML = 160;

const IMPACTS: readonly Impact[] = ["critical", "serious", "moderate", "minor"];

/** A criterion tag: wcag412 is 4.1.2. */
const CRITERION = /^wcag(\d)(\d)(\d{1,2})$/;

/** A level tag: wcag2a, wcag21aa, wcag22aa. */
const LEVEL = /^wcag\d{1,2}(a{1,3})$/;

/**
 * Read the WCAG criteria a rule maps to.
 *
 * axe tags rules for several standards at once. Only the WCAG
 * ones are read here, since quoting EN 301 549 clauses at
 * somebody who asked about WCAG is noise.
 */
export function criteriaOf(tags: readonly string[]): readonly string[] {
	const found: string[] = [];
	for (const tag of tags) {
		const parts = CRITERION.exec(tag);
		if (parts) found.push(`${parts[1]}.${parts[2]}.${parts[3]}`);
	}
	return found;
}

/** Read the conformance levels a rule belongs to. */
export function levelsOf(tags: readonly string[]): readonly string[] {
	const found = new Set<string>();
	for (const tag of tags) {
		const parts = LEVEL.exec(tag);
		if (parts?.[1]) found.add(parts[1].toUpperCase());
	}
	return [...found].sort();
}

/**
 * Whether a rule states a standard or an opinion.
 *
 * axe marks its own recommendations best-practice. They are good
 * advice and they are not WCAG, and a report that blurs the two
 * tells somebody their page fails a standard when it does not.
 */
export function authorityOf(tags: readonly string[]): Authority {
	if (criteriaOf(tags).length > 0) return "wcag";
	// A level tag on its own still says this is a WCAG rule. Every
	// rule axe ships today carries both, so this changes nothing
	// today; it matters because the mark at the top of the report
	// now turns on this answer, and the failure it would cause is
	// the bad one. Reading a real criterion as advice downgrades a
	// violation to WARN and hides it.
	return levelsOf(tags).length > 0 ? "wcag" : "best-practice";
}

function impactOf(value: string | null | undefined): Impact {
	return IMPACTS.find((impact) => impact === value) ?? "minor";
}

function selectorOf(node: RawAxeNode): string {
	const first = node.target?.[0];
	if (typeof first === "string") return first;
	// A nested array is axe's way of naming a frame path.
	if (Array.isArray(first)) return first.join(" >> ");
	return "(unlocated)";
}

function messagesOf(node: RawAxeNode): readonly string[] {
	const checks = [
		...(node.any ?? []),
		...(node.all ?? []),
		...(node.none ?? []),
	];
	const messages = checks
		.map((check) => check.message)
		.filter((message): message is string => Boolean(message));
	return messages.length > 0
		? [...new Set(messages)]
		: node.failureSummary
			? [node.failureSummary]
			: [];
}

function clip(html: string | undefined): string {
	if (!html) return "";
	const flat = html.replace(/\s+/g, " ").trim();
	return flat.length <= MAX_NODE_HTML
		? flat
		: `${flat.slice(0, MAX_NODE_HTML)}...`;
}

/**
 * The rule switches to hand axe, turning on the experimental
 * rules that carry a WCAG criterion and touching nothing else.
 *
 * Enabling by name rather than by tag on purpose: a runOnly tag
 * list replaces the default set instead of adding to it, so any
 * rule whose tags fell outside the list would quietly stop
 * running. Widening an audit must not narrow it.
 */
export function enabledRules(
	bar: ConformanceBar = "AAA",
): Record<string, { enabled: true }> {
	const switches: Record<string, { enabled: true }> = {};
	for (const rule of EXPERIMENTAL_WCAG_RULES) {
		switches[rule] = { enabled: true };
	}
	// The enhanced rules are only asked for when the enhanced bar is,
	// because switching them on always would report AAA failures
	// against a page that never claimed to reach for AAA.
	if (bar === "AAA") {
		for (const rule of ENHANCED_WCAG_RULES) {
			switches[rule] = { enabled: true };
		}
	}
	return switches;
}

/**
 * Turn one raw axe result into a finding.
 *
 * A rule axe tags experimental never comes back decided. Five of
 * those rules carry real WCAG criteria and are switched off by
 * default, so running them is the only way some criteria get
 * checked at all, 2.5.3 among them. But axe declines to trust
 * their judgement, and repeating what they say as a settled
 * failure would be claiming an authority its author did not.
 * They are reported as needing a person, which is what they are.
 */
export function readResult(
	result: RawAxeResult,
	kind: FindingKind,
): A11yFinding {
	const tags = result.tags ?? [];
	return {
		rule: result.id,
		kind: tags.includes("experimental") ? "needs-review" : kind,
		impact: impactOf(result.impact),
		authority: authorityOf(tags),
		criteria: criteriaOf(tags),
		levels: levelsOf(tags),
		help: result.help ?? result.description ?? result.id,
		...(result.helpUrl === undefined ? {} : { helpUrl: result.helpUrl }),
		nodes: (result.nodes ?? []).map((node) => ({
			selector: selectorOf(node),
			html: clip(node.html),
			messages: messagesOf(node),
		})),
	};
}

/**
 * Read a whole axe run.
 *
 * Findings are ordered by how much they bite, then by rule, so
 * the first thing read is the worst thing found. Violations come
 * before the ones needing review, because a thing known to be
 * broken outranks a thing that might be.
 */
export function readAxeRun(run: RawAxeRun): readonly A11yFinding[] {
	const findings = [
		...(run.violations ?? []).map((result) => readResult(result, "violation")),
		...(run.incomplete ?? []).map((result) =>
			readResult(result, "needs-review"),
		),
	];
	return orderFindings(findings);
}

/** Worst first, and what is known broken before what might be. */
export function orderFindings(
	findings: readonly A11yFinding[],
): readonly A11yFinding[] {
	return [...findings].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "violation" ? -1 : 1;
		const severity = IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact);
		return severity === 0 ? a.rule.localeCompare(b.rule) : severity;
	});
}

/**
 * Put two rule sets into one ordered report.
 *
 * A reader should not have to know which rule set caught a
 * thing in order to act on it, so the sets are interleaved by
 * severity rather than listed one after the other.
 *
 * Where both report the same thing, the primary set wins. Two
 * entries saying the same thing is worse than either alone, and
 * the overlap is not always visible from the rule names: a
 * secondary rule can declare which primary rule supersedes it.
 */
export function mergeFindings(
	primary: readonly A11yFinding[],
	secondary: readonly A11yFinding[],
	supersededBy: Readonly<Record<string, string>> = {},
): readonly A11yFinding[] {
	const taken = new Set(primary.map((finding) => finding.rule));
	return orderFindings([
		...primary,
		...secondary.filter(
			(finding) =>
				!taken.has(finding.rule) &&
				!taken.has(supersededBy[finding.rule] ?? ""),
		),
	]);
}

/** A count of findings and elements, for a headline. */
export interface AxeTally {
	readonly violations: number;
	readonly needsReview: number;
	/** Elements that failed a rule. Excludes the undecided ones. */
	readonly elements: number;
	/** Elements axe declined to judge. */
	readonly reviewElements: number;
	readonly byImpact: Readonly<Record<Impact, number>>;
	readonly wcag: number;
	readonly bestPractice: number;
}

/** Count what was found. */
export function tallyFindings(findings: readonly A11yFinding[]): AxeTally {
	const byImpact: Record<Impact, number> = {
		critical: 0,
		serious: 0,
		moderate: 0,
		minor: 0,
	};
	let elements = 0;
	let reviewElements = 0;
	let wcag = 0;
	let bestPractice = 0;
	let violations = 0;
	let needsReview = 0;
	for (const finding of findings) {
		if (finding.kind === "violation") {
			// Counted apart, because an element nobody could judge has
			// not been shown to be broken and must not inflate a
			// failure count.
			elements += finding.nodes.length;
			violations += 1;
			byImpact[finding.impact] += 1;
			if (finding.authority === "wcag") wcag += 1;
			else bestPractice += 1;
		} else {
			reviewElements += finding.nodes.length;
			needsReview += 1;
		}
	}
	return {
		violations,
		needsReview,
		elements,
		reviewElements,
		byImpact,
		wcag,
		bestPractice,
	};
}
