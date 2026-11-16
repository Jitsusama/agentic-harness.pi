/**
 * The keyboard walk's findings as a person reads them: a headline,
 * each barrier with what it costs a keyboard user, and the first
 * pass of stops.
 *
 * Kept apart from the walk's judgement because the wording, the
 * caps on how much is listed and the order things are said in
 * change with readers, while what counts as a barrier does not.
 */

import { NON_TEXT_MINIMUM } from "../audit/contrast.ts";
import {
	count,
	renderVerdict,
	standingFor,
	wasWere,
} from "../audit/verdict.ts";
import type { WalkCandidate, WalkFindings } from "./walk-types.ts";

/**
 * Whether an outline is actually drawn.
 *
 * A width survives in the computed style even when the style is
 * none, so an element with no outline at all still reports three
 * pixels of it. Comparing widths alone would call that a change.
 */
/**
 * Say how many controls the trap shut out, and name a few.
 *
 * A bare count is the least useful true thing available here: a
 * reader who is told six controls are stranded still has to go
 * and find out which. These are the controls a keyboard user can
 * no longer reach, so they are worth naming.
 */
function strandedSentence(stranded: readonly WalkCandidate[]): string {
	const named = stranded
		.map((candidate) => candidate.name || candidate.tag)
		.filter((name) => name.length > 0);
	const shown = named.slice(0, MAX_NAMED_STRANDED);
	const rest = named.length - shown.length;
	const list =
		shown.length === 0
			? ""
			: `: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
	const count =
		stranded.length === 1
			? "1 control is stranded outside it"
			: `${stranded.length} controls are stranded outside it`;
	return `  ${count}${list}.`;
}

/** How many stranded controls to name before counting the rest. */
const MAX_NAMED_STRANDED = 6;

/** How many stops are worth listing before summarising. */
const MAX_LISTED_STOPS = 40;

/**
 * How many of anything else is worth naming before counting.
 *
 * The tab order has always stopped at forty and said how many
 * more there were. The finding lists beside it printed every
 * entry, so one article answered with two hundred and fifty
 * unvisited control names, longer than the rest of the report
 * together and mostly repetitions of the same word.
 */
export const MAX_LISTED_FINDINGS = 12;

/** Name a few, count the rest, in one place for every list. */
function listSome(
	lines: string[],
	entries: readonly string[],
	cap = MAX_LISTED_FINDINGS,
): void {
	for (const entry of entries.slice(0, cap)) lines.push(`  ${entry}`);
	if (entries.length > cap) {
		lines.push(`  ... and ${entries.length - cap} more.`);
	}
}

/** The walk, as a person would report it. */
export function renderWalk(findings: WalkFindings): string {
	const lines: string[] = [];
	const real = findings.stops.filter((stop) => stop.index >= 0);

	// A tab order is a cycle, so the walk deliberately goes round
	// more than once to prove it. Printing every lap would say the
	// same thing ten times over; the distinct stops, in the order
	// they were first reached, say all of it.
	const seen = new Set<number>();
	const firstPass = real.filter((stop) => {
		if (seen.has(stop.index)) return false;
		seen.add(stop.index);
		return true;
	});
	const looped = real.length > firstPass.length;

	const measured =
		`Tabbed through ${firstPass.length} distinct stops` +
		`${looped ? ", then the order repeated" : ""}.`;

	if (findings.trap) {
		const names = findings.trap.members
			.map((stop) => stop.name || stop.tag)
			.join(", ");
		lines.push(
			`FOCUS TRAP: once inside, tab only ever reaches ${names}.`,
			findings.trap.escapeFreed
				? "  Escape does get out, so a keyboard user is not stranded."
				: "  Escape does not get out either. There is no way back to " +
						"the page without a mouse.",
			strandedSentence(findings.trap.stranded),
			"",
		);
	}

	if (findings.noIndicator.length > 0) {
		lines.push("No visible focus indicator, so focus cannot be followed:");
		listSome(
			lines,
			findings.noIndicator.map(
				(stop) => `${stop.name || stop.tag} (${stop.tag.toLowerCase()})`,
			),
		);
		lines.push("");
	}

	if (findings.faintIndicator.length > 0) {
		lines.push(
			"Focus indicator too faint to make out, which 2.4.11 holds " +
				`to ${NON_TEXT_MINIMUM}:1:`,
		);
		listSome(
			lines,
			findings.faintIndicator.map(
				(faint) =>
					`${faint.stop.name || faint.stop.tag} ` +
					`(${faint.stop.tag.toLowerCase()}) at ${faint.ratio}:1`,
			),
		);
		lines.push("");
	}

	if (findings.outOfOrder.length > 0) {
		lines.push(
			"Side by side, but tabbed in the opposite order to the one " +
				"they read in (2.4.3, worth a look rather than a failure):",
		);
		listSome(
			lines,
			findings.outOfOrder.map(
				(jump) =>
					`${jump.before.name || jump.before.tag} is reached before ` +
					`${jump.after.name || jump.after.tag}, which sits to its left`,
			),
		);
		lines.push("");
	}

	if (findings.unreachable.length > 0) {
		lines.push("Behaves interactively but tab never reaches it:");
		listSome(
			lines,
			findings.unreachable.map(
				(item) =>
					`${item.name || item.tag} (${item.tag.toLowerCase()}) ` +
					`- ${item.because}`,
			),
		);
		lines.push("");
	}

	if (findings.positiveTabindex.length > 0) {
		lines.push(
			"Positive tabindex, which pulls these ahead of everything else " +
				"on the page:",
		);
		listSome(
			lines,
			findings.positiveTabindex.map(
				(candidate) =>
					`${candidate.name || candidate.tag} (tabindex ` +
					`${candidate.tabindex})`,
			),
		);
		lines.push("");
	} else if (findings.reordered) {
		lines.push("The tab order does not follow the document order.", "");
	}

	if (findings.offscreen.length > 0) {
		lines.push("Focused while off screen, so the page appears not to react:");
		listSome(
			lines,
			findings.offscreen.map((stop) => stop.name || stop.tag),
		);
		lines.push("");
	}

	if (
		findings.missed.length > 0 &&
		!findings.trap &&
		!findings.modalHeldFocus
	) {
		lines.push(
			findings.cappedAt === undefined
				? `${findings.missed.length} focusable things were never reached:`
				: `${findings.missed.length} focusable things were not visited ` +
						`before the walk hit its ${findings.cappedAt}-stop budget. ` +
						"Raise maxStops to walk the rest:",
		);
		listSome(
			lines,
			findings.missed.map((candidate) => candidate.name || candidate.tag),
		);
		lines.push("");
	}

	lines.push("The order tab took:");
	for (const [at, stop] of firstPass.slice(0, MAX_LISTED_STOPS).entries()) {
		const indicator = findings.indicators.get(stop.index);
		const ring = indicator && indicator !== "none" ? "" : "  [no ring]";
		lines.push(
			`  ${String(at + 1).padStart(2)}. ${stop.name || stop.tag}${ring}`,
		);
	}
	if (firstPass.length > MAX_LISTED_STOPS) {
		lines.push(`  ... and ${firstPass.length - MAX_LISTED_STOPS} more.`);
	}

	// A trap or an unreachable control is a page a keyboard user
	// cannot finish using, so those fail. An invisible ring or a
	// rearranged order makes the page hard rather than impossible.
	//
	// A walk that ran out of budget has not finished looking, so
	// what it did not reach is unvisited rather than unreachable.
	// Counting those as failures made the tool's own limit read as
	// the page's defect, and maxStops the shortest route to a
	// fabricated critical verdict.
	//
	// A modal holding focus excludes the page behind it on purpose,
	// so what it kept focus away from is neither missed nor a
	// budget overrun.
	const excused = findings.cappedAt !== undefined || findings.modalHeldFocus;
	const failures =
		(findings.trap ? 1 : 0) +
		findings.unreachable.length +
		(excused ? 0 : findings.missed.length);
	const warnings =
		findings.noIndicator.length +
		findings.faintIndicator.length +
		findings.offscreen.length +
		findings.positiveTabindex.length +
		(findings.reordered ? 1 : 0) +
		// A walk that laps inside a modal always spends its whole
		// budget and never reaches the page behind. The dialog was the
		// limit, not the budget, so this is not something to raise.
		(!findings.modalHeldFocus &&
		findings.cappedAt !== undefined &&
		findings.missed.length > 0
			? 1
			: 0);

	return renderVerdict(
		{
			standing: standingFor({ failures, warnings }),
			headline: headlineFor(findings, warnings),
			measured,
		},
		lines.join("\n"),
	);
}

/** Say the worst true thing about the walk, in one line. */
function headlineFor(findings: WalkFindings, warnings: number): string {
	if (findings.trap) {
		return findings.trap.escapeFreed
			? "Focus is trapped, though Escape gets out."
			: "Focus is trapped with no way out but a mouse.";
	}
	// Focus held inside a dialog is the pattern working. The
	// background controls it excludes are what a modal is for, so
	// they are neither missed nor a budget problem.
	if (findings.modalHeldFocus) {
		return (
			"A modal dialog is holding focus, which is correct. " +
			`Tab cycles its ${findings.stops.length > 0 ? "controls" : "content"} ` +
			"and does not reach the page behind it."
		);
	}
	if (findings.cappedAt !== undefined && findings.missed.length > 0) {
		return (
			`The walk stopped at its ${findings.cappedAt}-stop budget with ` +
			`${findings.missed.length} controls not yet visited.`
		);
	}
	// Two different faults, so they are counted and named
	// separately. Summing them under one sentence reported "6 things
	// can be operated but never focused" for a page with one such
	// thing and five unvisited controls, and the report below it
	// listed the one, so the headline argued with its own detail.
	if (findings.unreachable.length > 0 && findings.missed.length > 0) {
		return (
			`${count(findings.unreachable.length, "thing")} can be operated ` +
			`but never focused, and ${count(findings.missed.length, "control")} ` +
			`${wasWere(findings.missed.length)} never reached.`
		);
	}
	if (findings.unreachable.length > 0) {
		return `${count(
			findings.unreachable.length,
			"thing",
		)} can be operated but never focused.`;
	}
	if (findings.missed.length > 0) {
		return (
			`${count(findings.missed.length, "control")} ` +
			`${wasWere(findings.missed.length)} never reached.`
		);
	}
	if (warnings > 0) {
		return warnings === 1
			? "Every control was reached, but 1 stop is hard to follow."
			: `Every control was reached, but ${warnings} stops are hard to follow.`;
	}
	// Only Tab was pressed, so this cannot claim the controls
	// operate. Nor can it claim the visual order matches: the check
	// that exists catches two controls side by side tabbed against
	// the way they read, and deliberately declines the general
	// question, because deciding whether a layout is meant to be
	// read in rows or columns is not something geometry settles.
	// Saying "in order, with focus visible" asserted both.
	//
	// Nor can it say the rings are visible. It once did, on the
	// strength of the style changing on focus, which is a different
	// claim wearing the same word: a ring one shade off its
	// background changes the style and cannot be seen. Contrast is
	// measured now, but only for outlines over a known surface, so
	// "visible" would still be speaking for the shadows and
	// see-through backgrounds this declines to judge. What is true
	// of every control here is that focus does something visible to
	// it, and the faint ones are listed above by name.
	return "Tab reached every control, each with a focus indicator.";
}
