/**
 * Structural accessibility rules of our own.
 *
 * These sit beside axe rather than duplicating it. Some are
 * things axe reports only as best practice, where the failure is
 * in fact severe; some it declines to decide; some it does not
 * look at. Every one of them is a question about how a page is
 * put together rather than how it is painted, which is why they
 * can run against a stored capture.
 *
 * Nothing here parses CSS or re-derives a role. Roles and names
 * come from the browser's accessibility tree and attributes come
 * from its snapshot, joined before they arrive. What this module
 * contributes is the reasoning about relationships between them:
 * which reference points nowhere, which control is buried inside
 * another, which heading skipped a level.
 */

import type { A11yFinding, FindingNode, Impact } from "./axe.js";

/** One element, as these rules need to see it. */
export interface StructureNode {
	/** Stable id for addressing, from whatever captured it. */
	readonly id: string;
	/** A selector or path a person can use to find it. */
	readonly selector: string;
	readonly tag: string;
	readonly attributes: Readonly<Record<string, string>>;
	/** The browser's computed role, when it has one. */
	readonly role?: string;
	/** The browser's computed accessible name. */
	readonly name?: string;
	/** Whether the browser says this can take focus. */
	readonly focusable: boolean;
	/** Whether the browser drew it. */
	readonly rendered: boolean;
	/** Ancestor ids, nearest first. */
	readonly ancestors: readonly string[];
	/** The element's own markup, already clipped. */
	readonly html?: string;
}

/** Attributes whose value is one or more element ids. */
export const IDREF_ATTRIBUTES = [
	"aria-labelledby",
	"aria-describedby",
	"aria-controls",
	"aria-owns",
	"aria-details",
	"aria-errormessage",
	"aria-flowto",
] as const;

/** Attributes holding exactly one id. */
export const SINGLE_IDREF_ATTRIBUTES = [
	"aria-activedescendant",
	"for",
] as const;

/** Roles that name a region of the page. */
export const LANDMARK_ROLES = [
	"banner",
	"complementary",
	"contentinfo",
	"form",
	"main",
	"navigation",
	"region",
	"search",
] as const;

/** Roles a person operates, for the nesting rule. */
const INTERACTIVE_ROLES = new Set([
	"button",
	"checkbox",
	"combobox",
	"link",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"radio",
	"searchbox",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"textbox",
]);

/** Roles that must hold a name from the author, not the content. */
const NEEDS_LABEL_ROLES = new Set([
	"checkbox",
	"combobox",
	"listbox",
	"radio",
	"searchbox",
	"slider",
	"spinbutton",
	"switch",
	"textbox",
]);

interface Rule {
	readonly rule: string;
	readonly impact: Impact;
	readonly criteria: readonly string[];
	readonly levels: readonly string[];
	readonly help: string;
}

function finding(rule: Rule, nodes: readonly FindingNode[]): A11yFinding[] {
	if (nodes.length === 0) return [];
	return [
		{
			rule: rule.rule,
			kind: "violation",
			impact: rule.impact,
			authority: rule.criteria.length > 0 ? "wcag" : "best-practice",
			criteria: rule.criteria,
			levels: rule.levels,
			help: rule.help,
			nodes,
		},
	];
}

function nodeOf(node: StructureNode, message: string): FindingNode {
	return {
		selector: node.selector,
		html: node.html ?? "",
		messages: [message],
	};
}

/**
 * References that point at nothing.
 *
 * A broken aria-labelledby does not degrade, it erases: the
 * element ends up with no accessible name at all rather than
 * falling back to its content. That makes this more severe than
 * the "invalid attribute value" it is usually filed under.
 */
export function brokenReferences(
	nodes: readonly StructureNode[],
): readonly A11yFinding[] {
	const present = new Set(
		nodes.map((node) => node.attributes.id).filter(Boolean),
	);
	const broken: FindingNode[] = [];

	for (const node of nodes) {
		for (const attribute of [...IDREF_ATTRIBUTES, ...SINGLE_IDREF_ATTRIBUTES]) {
			const value = node.attributes[attribute];
			if (!value) continue;
			const single = (SINGLE_IDREF_ATTRIBUTES as readonly string[]).includes(
				attribute,
			);
			const wanted = single ? [value.trim()] : value.trim().split(/\s+/);
			const missing = wanted.filter((id) => id !== "" && !present.has(id));
			if (missing.length === 0) continue;
			broken.push(
				nodeOf(
					node,
					`${attribute} points at ${missing
						.map((id) => `'${id}'`)
						.join(", ")}, which ${
						missing.length === 1 ? "is not" : "are not"
					} on the page.`,
				),
			);
		}
	}

	return finding(
		{
			rule: "reference-resolves",
			impact: "critical",
			criteria: ["1.3.1", "4.1.2"],
			levels: ["A"],
			help:
				"ARIA references must point at elements that exist. A broken " +
				"aria-labelledby erases the name rather than falling back to it.",
		},
		broken,
	);
}

/**
 * Things hidden from assistive technology but still tabbable.
 *
 * This is the worst kind of inconsistency, because the page
 * behaves differently depending on which way somebody uses it:
 * focus lands on something a screen reader will not announce, so
 * the user is somewhere they cannot be told about.
 */
export function hiddenButFocusable(
	nodes: readonly StructureNode[],
): readonly A11yFinding[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const found: FindingNode[] = [];

	for (const node of nodes) {
		if (!node.focusable || !node.rendered) continue;
		if (node.attributes["aria-hidden"] === "true") {
			found.push(nodeOf(node, "It is aria-hidden and can still be focused."));
			continue;
		}
		const hiding = node.ancestors
			.map((id) => byId.get(id))
			.find((ancestor) => ancestor?.attributes["aria-hidden"] === "true");
		if (hiding) {
			found.push(
				nodeOf(
					node,
					`An ancestor (${hiding.selector}) is aria-hidden, so this ` +
						"is announced to nobody but still takes focus.",
				),
			);
		}
	}

	return finding(
		{
			rule: "hidden-focusable",
			impact: "critical",
			criteria: ["1.3.1", "4.1.2"],
			levels: ["A"],
			help:
				"Anything aria-hidden must not be focusable. Focus lands " +
				"somewhere a screen reader will not announce.",
		},
		found,
	);
}

/**
 * Controls buried inside other controls.
 *
 * What happens on a click is then undefined in practice: the
 * browser flattens the pair differently from the accessibility
 * tree, so what a mouse does and what a screen reader reports
 * stop agreeing.
 */
export function nestedInteractives(
	nodes: readonly StructureNode[],
): readonly A11yFinding[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const found: FindingNode[] = [];

	for (const node of nodes) {
		if (!node.role || !INTERACTIVE_ROLES.has(node.role)) continue;
		const inside = node.ancestors
			.map((id) => byId.get(id))
			.find(
				(ancestor) => ancestor?.role && INTERACTIVE_ROLES.has(ancestor.role),
			);
		if (!inside) continue;
		found.push(
			nodeOf(
				node,
				`A ${node.role} inside a ${inside.role} (${inside.selector}). ` +
					"Only one of them can receive the interaction.",
			),
		);
	}

	return finding(
		{
			rule: "nested-interactive",
			impact: "serious",
			criteria: ["1.3.1", "4.1.2"],
			levels: ["A"],
			help:
				"An interactive element must not contain another. The mouse " +
				"and the accessibility tree disagree about what was operated.",
		},
		found,
	);
}

/**
 * Headings that skip a level, and pages with several firsts.
 *
 * Headings are how most screen reader users navigate a long
 * page, so a broken outline is a broken table of contents rather
 * than a cosmetic complaint.
 */
export function headingOutline(
	nodes: readonly StructureNode[],
): readonly A11yFinding[] {
	// See SUPERSEDED_BY: axe reports the skip too, and classifies
	// it as best practice rather than a criterion. Its judgment
	// wins where both fire; this runs for captures with no axe.
	const headings = nodes
		.filter((node) => node.rendered)
		.map((node) => ({ node, level: headingLevel(node) }))
		.filter((entry): entry is { node: StructureNode; level: number } =>
			Boolean(entry.level),
		);

	const skipped: FindingNode[] = [];
	const firsts: FindingNode[] = [];
	let previous = 0;

	for (const { node, level } of headings) {
		if (level === 1)
			firsts.push(nodeOf(node, `Heading level 1: ${node.name ?? ""}`));
		if (previous > 0 && level > previous + 1) {
			skipped.push(
				nodeOf(
					node,
					`Jumps from level ${previous} to level ${level}, so the ` +
						`level ${previous + 1} it belongs under is missing.`,
				),
			);
		}
		previous = level;
	}

	return [
		...finding(
			{
				rule: "heading-skips-level",
				impact: "moderate",
				criteria: ["1.3.1"],
				levels: ["A"],
				help:
					"Heading levels must not skip. Headings are how a page is " +
					"navigated without sight, and a gap breaks the outline.",
			},
			skipped,
		),
		...finding(
			{
				rule: "single-first-heading",
				impact: "moderate",
				criteria: [],
				levels: [],
				help:
					"A page should have one level 1 heading naming what the " +
					"page is. Several leaves no single answer.",
			},
			firsts.length > 1 ? firsts : [],
		),
	];
}

function headingLevel(node: StructureNode): number | undefined {
	const fromTag = /^h([1-6])$/.exec(node.tag);
	if (fromTag?.[1]) return Number(fromTag[1]);
	if (node.role !== "heading") return undefined;
	const declared = node.attributes["aria-level"];
	return declared ? Number(declared) : undefined;
}

/**
 * Landmarks that cannot be told apart.
 *
 * Two navigations are fine and common. Two navigations with no
 * names are a menu with two identical entries: the reader is
 * offered a choice they have no way to make.
 */
export function landmarkNaming(
	nodes: readonly StructureNode[],
): readonly A11yFinding[] {
	const landmarks = nodes.filter(
		(node) =>
			node.rendered &&
			node.role &&
			(LANDMARK_ROLES as readonly string[]).includes(node.role),
	);

	const found: FindingNode[] = [];
	const byRole = new Map<string, StructureNode[]>();
	for (const node of landmarks) {
		const role = node.role ?? "";
		byRole.set(role, [...(byRole.get(role) ?? []), node]);
	}

	for (const [role, group] of byRole) {
		if (group.length < 2) continue;
		const unnamed = group.filter((node) => !node.name?.trim());
		if (unnamed.length < 2) continue;
		for (const node of unnamed) {
			found.push(
				nodeOf(
					node,
					`One of ${group.length} ${role} landmarks, and ${unnamed.length} ` +
						"of them have no name to tell them apart.",
				),
			);
		}
	}

	return finding(
		{
			rule: "landmark-distinguishable",
			impact: "moderate",
			criteria: ["1.3.1"],
			levels: ["A"],
			help:
				"Repeated landmarks of the same role need names. Without them " +
				"the landmark menu offers a choice nobody can make.",
		},
		found,
	);
}

/**
 * Controls with nothing to call them, and errors nobody is told
 * about.
 *
 * The second half is the one tools usually miss: aria-invalid
 * announces that something is wrong without saying what, and the
 * message sitting next to it in the layout is not connected to
 * it in any way a screen reader can follow.
 */
export function formLabelling(
	nodes: readonly StructureNode[],
): readonly A11yFinding[] {
	const unnamed: FindingNode[] = [];
	const unexplained: FindingNode[] = [];

	for (const node of nodes) {
		if (!node.rendered || !node.role) continue;
		// Native fields are axe's ground, and it checks them more
		// thoroughly than this could: wrapped labels, explicit
		// labels, titles and placeholders each have their own rule.
		// What is left to us is a field made out of ARIA, which its
		// label rule does not look at.
		const isNative =
			node.tag === "input" || node.tag === "select" || node.tag === "textarea";
		if (!isNative && !NEEDS_LABEL_ROLES.has(node.role)) continue;
		if (isNative && node.attributes.type === "hidden") continue;

		if (!isNative && !node.name?.trim()) {
			unnamed.push(
				nodeOf(
					node,
					"No accessible name: nothing tells the user what to type.",
				),
			);
		}
		// Error association, though, is nobody else's ground: axe
		// has no rule for it, and it matters on a native field just
		// as much as on an ARIA one.
		if (
			node.attributes["aria-invalid"] === "true" &&
			!node.attributes["aria-errormessage"] &&
			!node.attributes["aria-describedby"]
		) {
			unexplained.push(
				nodeOf(
					node,
					"Marked invalid with no aria-errormessage or " +
						"aria-describedby, so the reason is announced to nobody.",
				),
			);
		}
	}

	return [
		...finding(
			{
				rule: "aria-field-has-name",
				impact: "critical",
				criteria: ["4.1.2"],
				levels: ["A"],
				help:
					"A field built from an ARIA role needs an accessible " +
					"name, the same as a native one.",
			},
			unnamed,
		),
		...finding(
			{
				rule: "error-is-announced",
				impact: "serious",
				criteria: ["3.3.1"],
				levels: ["A"],
				help:
					"A field marked invalid must point at the text explaining " +
					"why, or the error exists only visually.",
			},
			unexplained,
		),
	];
}

/**
 * Tab order set by hand.
 *
 * A positive tabindex pulls an element to the front of the tab
 * order for the whole page, so one of them rearranges everything
 * after it. It is almost always a local fix with a global cost.
 */
export function manualTabOrder(
	nodes: readonly StructureNode[],
): readonly A11yFinding[] {
	const found = nodes
		.filter((node) => Number(node.attributes.tabindex ?? "0") > 0)
		.map((node) =>
			nodeOf(
				node,
				`tabindex="${node.attributes.tabindex}" puts this ahead of ` +
					"everything with a natural order.",
			),
		);

	return finding(
		{
			rule: "no-positive-tabindex",
			impact: "serious",
			criteria: ["2.4.3"],
			levels: ["A"],
			help:
				"A positive tabindex reorders the whole page, not just the " +
				"element it is on.",
		},
		found,
	);
}

/**
 * Rules of ours that axe also reports, and under what name.
 *
 * These were written before running both against the same page,
 * which is the only way the overlap shows up. Where axe reports
 * the same thing, its finding wins: it carries a help URL, a
 * wider tag list, and a classification its authors argued
 * through. Two of these had been given WCAG criteria here that
 * axe deliberately withholds, and asserting a criterion a mature
 * rule set declined to assert wants better grounds than a
 * preference.
 *
 * Ours still run, because a capture audited without axe should
 * not lose the check entirely.
 */
export const SUPERSEDED_BY: Readonly<Record<string, string>> = {
	"heading-skips-level": "heading-order",
	"no-positive-tabindex": "tabindex",
	"landmark-distinguishable": "landmark-unique",
};

/** Every structural rule, run against one capture. */
export function analyseStructure(
	nodes: readonly StructureNode[],
): readonly A11yFinding[] {
	return [
		...brokenReferences(nodes),
		...hiddenButFocusable(nodes),
		...nestedInteractives(nodes),
		...headingOutline(nodes),
		...landmarkNaming(nodes),
		...formLabelling(nodes),
		...manualTabOrder(nodes),
	];
}
