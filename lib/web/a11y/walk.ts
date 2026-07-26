/**
 * The keyboard walk: what a person who never touches a mouse
 * can actually reach.
 *
 * Every finding here comes from what the browser did when Tab
 * was pressed, not from reading markup and predicting what it
 * ought to do. A focus trap written by hand, a positive tabindex
 * reordering the page, a div wearing a button's clothes: none of
 * these are visible in the markup as bugs, and all of them are
 * obvious the moment you try to tab through.
 *
 * The one judgment that is presentational, and labelled as such,
 * is whether a focus indicator exists: that is decided by
 * comparing what the browser computed for the element at rest
 * against what it computed with focus on it. Whether the
 * resulting indicator is bright enough to see is a contrast
 * question, and belongs with the contrast audit rather than
 * here; this module records the indicator so that audit can
 * judge it.
 */

import { renderVerdict, standingFor } from "../audit/verdict.js";

/** The style properties a focus indicator could live in. */
export interface FocusStyle {
	readonly outlineStyle: string;
	readonly outlineWidth: string;
	readonly outlineColor: string;
	readonly boxShadow: string;
	readonly backgroundColor: string;
	readonly borderColor: string;
	readonly color: string;
}

/** Something the browser says can hold focus. */
export interface WalkCandidate {
	/** Position in document order, and the identity used throughout. */
	readonly index: number;
	readonly tag: string;
	readonly id?: string;
	readonly role?: string;
	readonly name: string;
	readonly tabindex?: number;
	/** Inside an open dialog that is holding focus on purpose. */
	readonly inModal?: boolean;
	readonly resting: FocusStyle;
}

/** Where focus actually landed, once. */
export interface WalkStop {
	/** The candidate this is, or -1 when focus left them all. */
	readonly index: number;
	readonly tag: string;
	readonly id?: string;
	readonly name: string;
	readonly inViewport: boolean;
	/** Inside an open dialog that is holding focus on purpose. */
	readonly inModal?: boolean;
	readonly focused: FocusStyle;
}

/** Something that behaves interactively but cannot be reached. */
export interface Unreachable {
	readonly tag: string;
	readonly role?: string;
	readonly name: string;
	/** What made it look interactive. */
	readonly because: string;
}

/** Everything the driver observed while walking. */
export interface WalkCapture {
	readonly candidates: readonly WalkCandidate[];
	readonly stops: readonly WalkStop[];
	readonly unreachable: readonly Unreachable[];
	/** Whether pressing Escape freed focus, when it was stuck. */
	readonly escapeFreed?: boolean;
	/** True when the walk stopped at its cap rather than cycling. */
	readonly cappedAt?: number;
}

/** Where a focus indicator lives, if anywhere. */
export type Indicator =
	| "outline"
	| "boxShadow"
	| "background"
	| "border"
	| "colour"
	| "none";

/** A group of stops focus could not get out of. */
export interface Trap {
	readonly members: readonly WalkStop[];
	readonly escapeFreed: boolean;
	/**
	 * Controls outside the cycle, which is what makes it a trap.
	 *
	 * Not the same as the walk's `missed`: these may well have been
	 * visited on the way in. What matters is that focus cannot get
	 * back to them once it is inside.
	 */
	readonly stranded: readonly WalkCandidate[];
}

/** What the walk found. */
export interface WalkFindings {
	readonly stops: readonly WalkStop[];
	readonly trap?: Trap;
	/** Focusable things the walk never arrived at. */
	readonly missed: readonly WalkCandidate[];
	/** Stops whose appearance does not change when focused. */
	readonly noIndicator: readonly WalkStop[];
	/** Where the indicator lives, for those that have one. */
	readonly indicators: ReadonlyMap<number, Indicator>;
	/** Stops that were focused while off screen. */
	readonly offscreen: readonly WalkStop[];
	/** Candidates with a positive tabindex, which reorders the page. */
	readonly positiveTabindex: readonly WalkCandidate[];
	readonly unreachable: readonly Unreachable[];
	/** True when the tab order does not follow document order. */
	readonly reordered: boolean;
	/**
	 * The stop budget, when the walk ran out of it.
	 *
	 * Set means the page was not walked to the end, so anything in
	 * `missed` is unvisited rather than unreachable and cannot be
	 * counted as a failure.
	 */
	readonly cappedAt?: number;
	/** True when focus stayed inside a dialog that meant to hold it. */
	readonly modalHeldFocus: boolean;
}

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

function outlineDrawn(style: FocusStyle): boolean {
	return style.outlineStyle !== "none";
}

/**
 * Where the focus indicator lives, by comparing rest with focus.
 *
 * This is the honest test, and the only one that survives
 * contact with real pages: not whether the author wrote an
 * outline rule, but whether the browser draws anything
 * differently when the element has focus.
 */
export function indicatorOf(
	resting: FocusStyle,
	focused: FocusStyle,
): Indicator {
	const outlineChanged =
		outlineDrawn(focused) !== outlineDrawn(resting) ||
		(outlineDrawn(focused) &&
			(focused.outlineColor !== resting.outlineColor ||
				focused.outlineWidth !== resting.outlineWidth));
	if (outlineChanged) return "outline";
	if (focused.boxShadow !== resting.boxShadow) return "boxShadow";
	if (focused.backgroundColor !== resting.backgroundColor) return "background";
	if (focused.borderColor !== resting.borderColor) return "border";
	if (focused.color !== resting.color) return "colour";
	return "none";
}

/**
 * The shortest cycle the walk ended in, if it ended in one.
 *
 * A tab order that works is a cycle too: it comes back round to
 * the start. What makes a cycle a trap is that it is smaller
 * than the page, so the caller compares it against the
 * candidates rather than this function deciding alone.
 */
function trailingCycle(indices: readonly number[]): readonly number[] {
	for (let period = 1; period * 2 <= indices.length; period += 1) {
		const tail = indices.slice(-period);
		const before = indices.slice(-period * 2, -period);
		if (tail.every((value, at) => value === before[at])) return tail;
	}
	return [];
}

/** Read the walk. */
export function analyseWalk(capture: WalkCapture): WalkFindings {
	const { candidates, stops } = capture;

	const indicators = new Map<number, Indicator>();
	const noIndicator: WalkStop[] = [];
	const restingByIndex = new Map(
		candidates.map((candidate) => [candidate.index, candidate.resting]),
	);

	for (const stop of stops) {
		const resting = restingByIndex.get(stop.index);
		if (!resting) continue;
		const indicator = indicatorOf(resting, stop.focused);
		indicators.set(stop.index, indicator);
		if (
			indicator === "none" &&
			!noIndicator.some((s) => s.index === stop.index)
		) {
			noIndicator.push(stop);
		}
	}

	const visited = new Set(stops.map((stop) => stop.index));
	const missed = candidates.filter(
		(candidate) => !visited.has(candidate.index),
	);

	const cycle = trailingCycle(stops.map((stop) => stop.index));
	const cycleMembers = new Set(cycle);
	// A cycle is only a trap when something focusable sits outside
	// it. A page whose whole tab order loops is working correctly.
	//
	// Two things that are not traps used to be reported as one.
	//
	// A modal dialog contains focus deliberately: that is the
	// pattern working, and the background controls it excludes are
	// exactly what lands in `missed`, so the reference
	// implementation of an accessible dialog produced this check's
	// loudest possible output.
	//
	// A walk cut short by its own budget has not visited the rest
	// of the page yet. Everything it did not reach is unvisited,
	// not unreachable, and calling that a trap blames the page for
	// a limit we imposed.
	const inModal = (index: number) =>
		stops.some((stop) => stop.index === index && stop.inModal === true) ||
		candidates.some(
			(candidate) => candidate.index === index && candidate.inModal === true,
		);
	// Index -1 is focus resting on the body between laps rather
	// than on any candidate, which headless Chrome does every time
	// round. It is not a control the dialog failed to contain, so
	// it must not decide whether the cycle is inside one; leaving
	// it in made every real modal look like a leak.
	const cycled = cycle.filter((index) => index >= 0);
	const modalCycle = cycled.length > 0 && cycled.every(inModal);
	// A trap and a budget shortfall both end with the walk stopping
	// early, and telling them apart is the whole job here. The
	// signal is whether the walk was looping or still finding new
	// controls when it ran out: a settled cycle smaller than the
	// page is a trap however long we let it run, while a walk that
	// was still making progress simply needed more stops.
	const looping = cycled.length > 0;
	// What makes a cycle a trap is that focus cannot leave it, so
	// the question is which controls sit outside it, not which were
	// never visited.
	//
	// Those are different sets, and the difference is the commonest
	// trap there is. A page that tabs through its header, reaches a
	// widget and then cycles inside it for ever has visited every
	// control: nothing is missed, and asking about missed controls
	// called it clean. The header is still unreachable from inside
	// the widget, which is the whole complaint. The reference
	// keydown trap, two buttons swallowing Tab after two ordinary
	// links, was reported as passing for exactly this reason, and
	// only looked detected while phantom candidates were padding
	// the missed list.
	const outsideCycle = candidates.filter(
		(candidate) => !cycleMembers.has(candidate.index),
	);
	const trapped = looping && outsideCycle.length > 0 && !modalCycle;
	const ranOut = capture.cappedAt !== undefined && !looping;
	const trap: Trap | undefined = trapped
		? {
				// A cycle has no natural first member: where the repeat
				// was detected is an arbitrary rotation, so "In B, In A"
				// read oddly beside a tab order listing In A first.
				// Document order is the one the reader already has.
				members: [...cycleMembers]
					.sort((a, b) => a - b)
					.map((index) => stops.find((stop) => stop.index === index))
					.filter((stop): stop is WalkStop => stop !== undefined),
				escapeFreed: capture.escapeFreed === true,
				stranded: outsideCycle,
			}
		: undefined;

	const positiveTabindex = candidates.filter(
		(candidate) => (candidate.tabindex ?? 0) > 0,
	);

	// Document order is the order the candidates were collected
	// in, so a walk that visits them out of that order has been
	// reordered by something, almost always a positive tabindex.
	const arrival = stops
		.map((stop) => stop.index)
		.filter((index, at, all) => index >= 0 && all.indexOf(index) === at);
	// A modal legitimately takes focus out of document order: its
	// controls come after the background ones in the source and
	// before them in the tab order. Reporting that as a reordered
	// page blames the dialog for working.
	const reordered =
		!modalCycle &&
		arrival.some((index, at) => at > 0 && index < (arrival[at - 1] ?? -1));

	return {
		stops,
		...(trap ? { trap } : {}),
		missed,
		noIndicator,
		indicators,
		// The walk laps the page, so an offscreen stop is met once
		// per lap. It is one problem, not one per visit.
		offscreen: stops.filter(
			(stop, at) =>
				!stop.inViewport &&
				stop.index >= 0 &&
				stops.findIndex((other) => other.index === stop.index) === at,
		),
		positiveTabindex,
		unreachable: capture.unreachable,
		reordered,
		...(ranOut && capture.cappedAt !== undefined
			? { cappedAt: capture.cappedAt }
			: {}),
		modalHeldFocus: modalCycle,
	};
}

/** How many stops are worth listing before summarising. */
const MAX_LISTED_STOPS = 40;

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
		for (const stop of findings.noIndicator) {
			lines.push(`  ${stop.name || stop.tag} (${stop.tag.toLowerCase()})`);
		}
		lines.push("");
	}

	if (findings.unreachable.length > 0) {
		lines.push("Behaves interactively but tab never reaches it:");
		for (const item of findings.unreachable) {
			lines.push(
				`  ${item.name || item.tag} (${item.tag.toLowerCase()}) ` +
					`- ${item.because}`,
			);
		}
		lines.push("");
	}

	if (findings.positiveTabindex.length > 0) {
		lines.push(
			"Positive tabindex, which pulls these ahead of everything else " +
				"on the page:",
		);
		for (const candidate of findings.positiveTabindex) {
			lines.push(
				`  ${candidate.name || candidate.tag} (tabindex ` +
					`${candidate.tabindex})`,
			);
		}
		lines.push("");
	} else if (findings.reordered) {
		lines.push("The tab order does not follow the document order.", "");
	}

	if (findings.offscreen.length > 0) {
		lines.push("Focused while off screen, so the page appears not to react:");
		for (const stop of findings.offscreen) {
			lines.push(`  ${stop.name || stop.tag}`);
		}
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
		for (const candidate of findings.missed) {
			lines.push(`  ${candidate.name || candidate.tag}`);
		}
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
			headline: headlineFor(findings, failures, warnings),
			measured,
		},
		lines.join("\n"),
	);
}

/** Say the worst true thing about the walk, in one line. */
function headlineFor(
	findings: WalkFindings,
	failures: number,
	warnings: number,
): string {
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
	if (findings.unreachable.length > 0 || findings.missed.length > 0) {
		return `${failures} things can be operated but never focused.`;
	}
	if (warnings > 0) {
		return warnings === 1
			? "Every control was reached, but 1 stop is hard to follow."
			: `Every control was reached, but ${warnings} stops are hard to follow.`;
	}
	// Only Tab was pressed, and the order was compared against
	// document order, so this cannot claim the visual order matches
	// or that the controls operate. Saying "in order, with focus
	// visible" asserted both.
	return "Tab reached every control, each with a visible focus ring.";
}
