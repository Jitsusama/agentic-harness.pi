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

import { isOpaque, parseRgb } from "../audit/colour.js";
import { judgeNonText, NON_TEXT_MINIMUM } from "../audit/contrast.js";
import {
	count,
	renderVerdict,
	standingFor,
	wasWere,
} from "../audit/verdict.js";

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
	/** Where it sits, when the browser gave it a box. */
	readonly rect?: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
}

/** Two controls on one line that tab against the way they read. */
export interface VisualJump {
	readonly before: WalkStop;
	readonly after: WalkStop;
}

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
	/** Which way the page reads, from the document itself. */
	readonly direction?: "ltr" | "rtl";
}

/** Where a focus indicator lives, if anywhere. */
export type Indicator =
	| "outline"
	| "boxShadow"
	| "background"
	| "border"
	| "colour"
	| "none";

/** A focus ring that is there and cannot be seen. */
export interface FaintIndicator {
	readonly stop: WalkStop;
	/** Against what it is drawn on, where 2.4.11 asks for 3. */
	readonly ratio: number;
}

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
	/**
	 * Stops whose indicator exists but is too faint to make out.
	 *
	 * Kept apart from `noIndicator` because the repair differs: one
	 * needs a rule written, the other needs a colour changed.
	 */
	readonly faintIndicator: readonly FaintIndicator[];
	/**
	 * Pairs on one line that tab against the way they read.
	 *
	 * Undecided rather than failed: the geometry is certain, but
	 * whether it confuses anyone is a judgement about the page.
	 */
	readonly outOfOrder: readonly VisualJump[];
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
