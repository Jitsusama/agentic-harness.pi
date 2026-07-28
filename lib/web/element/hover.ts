/**
 * What the page does on hover, and whether the keyboard gets it too.
 *
 * A hover style is invisible to any static reading, and it is where
 * a particular accessibility fault hides: a control whose only cue
 * is a hover treatment tells a person using a keyboard nothing at
 * all. Answering that needs both halves. The stylesheets say which
 * elements might hover, which is cheap; only holding the state and
 * reading the computed style says what actually happens, because a
 * hover rule the cascade beat is a rule that does nothing.
 *
 * So the scan below is a candidate filter and never a finding. The
 * declared rule proposes; the computed style decides.
 *
 * Reading the page's own stylesheets is the one thing here that
 * runs inside the page, because `cssRules` is the only account of
 * them and it belongs to the document.
 */

import type { StyleChange } from "./pseudo.js";

/**
 * How many candidates to measure before stopping.
 *
 * Measured at roughly 9ms per candidate for a forced reading of two
 * states, so this is about half a second. A presentation default: a
 * caller who wants the whole page can say so.
 */
export const MAX_HOVER_CANDIDATES = 60;

/** How many elements to name before a group is only counted. */
const NAMED_PER_GROUP = 6;

/** What the page's stylesheets say might hover. */
export interface HoverScan {
	/** Base selectors, with the :hover part removed. */
	readonly selectors: readonly string[];
	/** Stylesheets whose rules the document refused to hand over. */
	readonly unreadableSheets: number;
}

/** One element, measured in both states. */
export interface HoverMeasurement {
	readonly element: string;
	readonly hover: readonly StyleChange[];
	readonly focus: readonly StyleChange[];
}

/** Elements sharing one treatment. */
export interface HoverGroup {
	readonly hover: readonly StyleChange[];
	readonly focus: readonly StyleChange[];
	readonly elements: readonly string[];
}

/** What the page does on hover. */
export interface HoverReport {
	/** How many elements were measured. */
	readonly candidates: number;
	/** Treatments that do something, commonest first. */
	readonly groups: readonly HoverGroup[];
	/** Treatments hover realizes and focus does not. */
	readonly pointerOnly: readonly HoverGroup[];
	/** Candidates whose hover rule realizes nothing. */
	readonly inert: readonly string[];
	readonly unreadableSheets: number;
}

/**
 * Find selectors carrying a :hover, in the page.
 *
 * Ships as a source string because it declares helpers. Two traps
 * are handled here rather than discovered later. A cross-origin
 * sheet throws on `cssRules` and is counted rather than skipped
 * silently. And CSS nesting gave every style rule a `cssRules` of
 * its own, empty and therefore truthy, so recursion has to test
 * the length: a walk that trusted truthiness descended into every
 * rule and read no selector at all, which reported a page full of
 * hover styles as having none.
 */
export const HOVER_SCAN = `(() => {
  const found = [];
  let unreadableSheets = 0;
  const walk = (list) => {
    for (const rule of list) {
      const selector = rule.selectorText;
      if (typeof selector === "string") {
        for (const part of selector.split(",")) {
          if (/:hover\\b/.test(part)) {
            const base = part.replace(/:hover\\b/g, "").trim();
            if (base) found.push(base);
          }
        }
      }
      if (rule.cssRules && rule.cssRules.length > 0) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules } catch { unreadableSheets += 1; continue }
    walk(rules);
  }
  return JSON.stringify({ selectors: [...new Set(found)], unreadableSheets });
})()`;

/** A stable signature for one set of changes. */
function signature(changes: readonly StyleChange[]): string {
	return [...changes]
		.map((change) => `${change.property}:${change.from}>${change.to}`)
		.sort()
		.join("|");
}

/** Fold measured candidates into what the page does on hover. */
export function foldHover(
	measurements: readonly HoverMeasurement[],
	unreadableSheets: number,
): HoverReport {
	const inert: string[] = [];
	const grouped = new Map<string, HoverGroup>();

	for (const measured of measurements) {
		if (measured.hover.length === 0) {
			// Declared and dead. Counting this as a treatment would credit
			// the page with a cue nobody can see.
			inert.push(measured.element);
			continue;
		}
		const key = `${signature(measured.hover)}##${signature(measured.focus)}`;
		const existing = grouped.get(key);
		if (existing) {
			grouped.set(key, {
				...existing,
				elements: [...existing.elements, measured.element],
			});
			continue;
		}
		grouped.set(key, {
			hover: measured.hover,
			focus: measured.focus,
			elements: [measured.element],
		});
	}

	const groups = [...grouped.values()].sort(
		(a, b) => b.elements.length - a.elements.length,
	);

	return {
		candidates: measurements.length,
		groups,
		// Hover does something, focus does nothing. Not a verdict: a page
		// may well put its focus ring on an ancestor or rely on the
		// browser's own. It is the thing worth looking at.
		pointerOnly: groups.filter((group) => group.focus.length === 0),
		inert,
		unreadableSheets,
	};
}

/** One change, said the way a stylesheet would. */
function describe(changes: readonly StyleChange[]): string {
	return changes
		.map((change) => `${change.property} ${change.from} to ${change.to}`)
		.join(", ");
}

/** Name a group's elements without printing a wall of them. */
function name(group: HoverGroup): string {
	const shown = group.elements.slice(0, NAMED_PER_GROUP).join(", ");
	const rest = group.elements.length - NAMED_PER_GROUP;
	return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/** Report what the page does on hover. */
export function renderHover(report: HoverReport): string {
	const lines: string[] = [];

	if (report.candidates === 0) {
		lines.push("Nothing on this page has a hover style.");
		if (report.unreadableSheets > 0) lines.push(unreadable(report));
		return lines.join("\n");
	}

	const many = report.candidates === 1 ? "element" : "elements";
	lines.push(
		`${report.candidates} ${many} carry a hover rule, ` +
			`${report.groups.length} distinct ${
				report.groups.length === 1 ? "treatment" : "treatments"
			}.`,
	);

	if (report.pointerOnly.length > 0) {
		const affected = report.pointerOnly.reduce(
			(total, group) => total + group.elements.length,
			0,
		);
		lines.push("");
		lines.push(
			`Hover is the only cue on ${affected} of them: the state ` +
				"changes for a pointer and nothing changes on focus, so a " +
				"person using a keyboard sees no equivalent. Worth checking " +
				"whether the focus ring lives on an ancestor before calling " +
				"it a fault.",
		);
		for (const group of report.pointerOnly) {
			lines.push(`  ${name(group)}: ${describe(group.hover)}`);
		}
	}

	const paired = report.groups.filter((group) => group.focus.length > 0);
	if (paired.length > 0) {
		lines.push("");
		lines.push("Hover and focus both answer:");
		for (const group of paired) {
			lines.push(`  ${name(group)}: ${describe(group.hover)}`);
		}
	}

	if (report.inert.length > 0) {
		lines.push("");
		const was = report.inert.length === 1 ? "element has" : "elements have";
		lines.push(
			`${report.inert.length} ${was} a hover rule that changes ` +
				"nothing, so the cascade beat it: " +
				`${report.inert.slice(0, NAMED_PER_GROUP).join(", ")}.`,
		);
	}

	if (report.unreadableSheets > 0) {
		lines.push("");
		lines.push(unreadable(report));
	}

	return lines.join("\n");
}

/** Say what was skipped, so the report is not read as complete. */
function unreadable(report: HoverReport): string {
	const sheets = report.unreadableSheets === 1 ? "stylesheet" : "stylesheets";
	return (
		`${report.unreadableSheets} ${sheets} could not be read, being ` +
		"cross-origin, so any hover rule in them was never considered."
	);
}
