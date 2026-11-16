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

import { isOpaque, parseRgb } from "../audit/colour.ts";
import { judgeNonText, NON_TEXT_MINIMUM } from "../audit/contrast.ts";
import type {
	FaintIndicator,
	FocusStyle,
	Indicator,
	Trap,
	VisualJump,
	WalkCandidate,
	WalkCapture,
	WalkFindings,
	WalkStop,
} from "./walk-types.ts";

export { MAX_LISTED_FINDINGS, renderWalk } from "./walk-render.ts";
export type {
	FocusStyle,
	Indicator,
	Unreachable,
	VisualJump,
	WalkCandidate,
	WalkCapture,
	WalkFindings,
	WalkStop,
} from "./walk-types.ts";

/**
 * How much two boxes must share vertically to count as one line.
 *
 * Buttons of different heights in a toolbar do not share a top
 * edge to the pixel, and demanding that they do would miss every
 * real case. Half the shorter one is enough to mean "beside",
 * and little enough to keep stacked rows apart.
 */
const SAME_LINE = 0.5;

/** Whether two boxes sit on the same line as a reader sees it. */
function beside(
	one: NonNullable<WalkStop["rect"]>,
	other: NonNullable<WalkStop["rect"]>,
): boolean {
	const overlap =
		Math.min(one.y + one.height, other.y + other.height) -
		Math.max(one.y, other.y);
	if (overlap <= 0) return false;
	return overlap >= Math.min(one.height, other.height) * SAME_LINE;
}

/**
 * Tab order that contradicts the order things are read in.
 *
 * Only same-line inversions, and deliberately so. The general
 * question, whether tab order follows the visual flow of the
 * page, cannot be answered without deciding whether a layout is
 * meant to be read in rows or in columns, and a two-column form
 * that tabs down one column and then the other is both extremely
 * common and perfectly correct. A check that flagged it would be
 * wrong far more often than right, and a false accessibility
 * finding costs more than a missing one.
 *
 * Two controls side by side, tabbed in the opposite order to the
 * one they are read in, has no such excuse. It is what
 * row-reverse and hand-set order values do, and the keyboard
 * order it produces contradicts the page for everybody.
 */
export function outOfVisualOrder(
	stops: readonly WalkStop[],
	direction: "ltr" | "rtl",
): readonly VisualJump[] {
	const jumps: VisualJump[] = [];

	for (let at = 1; at < stops.length; at += 1) {
		const before = stops[at - 1];
		const after = stops[at];
		if (before === undefined || after === undefined) continue;
		// A stop focus never reached, or one the browser gave no box,
		// says nothing about order.
		if (before.index === -1 || after.index === -1) continue;
		// The walk laps the page, so the step from the last control
		// back to the first is a cycle rather than a jump. Measured:
		// on an ordinary page that wrap is a right-to-left move
		// between two elements that happen to share a line, and it was
		// the check's first false positive.
		//
		// Within one lap, tab follows document order, which is the
		// order candidates are numbered in, so an ascending index is
		// what distinguishes a real step from the wrap. A page using
		// positive tabindex breaks that, and is reported separately
		// for doing so; missing a reversal there is the right way to
		// be wrong.
		if (after.index <= before.index) continue;
		const here = before.rect;
		const next = after.rect;
		if (here === undefined || next === undefined) continue;
		if (!beside(here, next)) continue;

		const backwards = direction === "rtl" ? next.x > here.x : next.x < here.x;
		if (backwards) jumps.push({ before, after });
	}

	return jumps;
}

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

/** What judging a focus indicator's visibility concluded. */
export interface IndicatorVerdict {
	readonly standing: "pass" | "fail" | "undecided";
	readonly ratio?: number;
	readonly reason: string;
}

/**
 * Whether a focus indicator can actually be seen.
 *
 * The walk decides an indicator exists by seeing the computed
 * style change. That is a weaker claim than it sounds, and the
 * gap between the two is where the real defect lives: a ring in
 * a colour a shade off the background satisfies every existence
 * check ever written and still leaves someone unable to tell
 * where they are. WCAG 2.4.11 puts the bar at 3:1 against what
 * the indicator is drawn against, which is the same bar 1.4.11
 * sets for any control's own colours.
 *
 * Only an outline is judged. A box shadow can be any number of
 * layers offset in any direction, a background or colour change
 * moves the very surface the comparison would use, and in
 * neither case does the computed value say which pixels changed.
 * Those come back undecided, which is this package's word for a
 * question it will not answer by guessing. A transparent surface
 * is undecided for the same reason: the colour behind the ring
 * belongs to some ancestor the computed style does not name, and
 * compositing against a guess is how a page gets accused of a
 * failure it does not have.
 */
export function judgeIndicator(input: {
	readonly indicator: Indicator;
	readonly resting: FocusStyle;
	readonly focused: FocusStyle;
}): IndicatorVerdict {
	if (input.indicator !== "outline") {
		return {
			standing: "undecided",
			reason:
				`the indicator is a ${input.indicator} change, and which ` +
				"pixels it alters cannot be read from the computed style",
		};
	}

	const ring = parseRgb(input.focused.outlineColor);
	const surface = parseRgb(input.resting.backgroundColor);
	if (!ring || !surface) {
		return {
			standing: "undecided",
			reason: "the ring or the surface behind it is not a plain colour",
		};
	}
	if (!isOpaque(surface)) {
		return {
			standing: "undecided",
			reason:
				"the surface behind the ring is see-through, so its " +
				"colour belongs to an ancestor this cannot name",
		};
	}

	const verdict = judgeNonText({ foreground: ring, background: surface });
	// The contrast layer has its own reasons for declining, and they
	// are better than any this one could invent, so they travel out
	// rather than being flattened into a generic shrug.
	if (verdict.kind === "undecidable") {
		return { standing: "undecided", reason: verdict.because };
	}
	return {
		standing: verdict.passes ? "pass" : "fail",
		ratio: verdict.ratio,
		reason: verdict.passes
			? `the ring reaches ${verdict.ratio}:1 against what it sits on`
			: `the ring reaches only ${verdict.ratio}:1 against what it ` +
				`sits on, short of the ${NON_TEXT_MINIMUM}:1 that 2.4.11 asks`,
	};
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

/**
 * Whether a set of stops reaches a candidate: it is one of them, or
 * a radio of its group is, since Tab stops once in a group and arrow
 * keys reach the rest.
 */
function coveredBy(
	candidates: readonly WalkCandidate[],
	indices: ReadonlySet<number>,
): (candidate: WalkCandidate) => boolean {
	const groups = new Set(
		candidates
			.filter((candidate) => indices.has(candidate.index))
			.map((candidate) => candidate.group),
	);
	return (candidate) =>
		indices.has(candidate.index) ||
		(candidate.group !== undefined && groups.has(candidate.group));
}

/** Read the walk. */
export function analyseWalk(capture: WalkCapture): WalkFindings {
	const { candidates, stops } = capture;

	const indicators = new Map<number, Indicator>();
	const noIndicator: WalkStop[] = [];
	const faintIndicator: FaintIndicator[] = [];
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
			continue;
		}
		// An indicator that exists still has to be visible. Only a
		// decided failure is collected: undecided is left alone rather
		// than reported as a maybe, because the walk's verdict is read
		// as a list of things to fix.
		const seen = judgeIndicator({ indicator, resting, focused: stop.focused });
		if (
			seen.standing === "fail" &&
			seen.ratio !== undefined &&
			!faintIndicator.some((faint) => faint.stop.index === stop.index)
		) {
			faintIndicator.push({ stop, ratio: seen.ratio });
		}
	}

	const visited = new Set(stops.map((stop) => stop.index));
	const reachedByVisit = coveredBy(candidates, visited);
	const missed = candidates.filter((candidate) => !reachedByVisit(candidate));

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
	const inCycle = coveredBy(candidates, cycleMembers);
	const outsideCycle = candidates.filter((candidate) => !inCycle(candidate));
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
		faintIndicator,
		// The page's own direction, when the capture reported it. A
		// right-to-left page reads the other way, and the geometry
		// that is wrong in English is correct in Arabic.
		outOfOrder: outOfVisualOrder(stops, capture.direction ?? "ltr"),
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
