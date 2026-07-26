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
}

/**
 * Whether an outline is actually drawn.
 *
 * A width survives in the computed style even when the style is
 * none, so an element with no outline at all still reports three
 * pixels of it. Comparing widths alone would call that a change.
 */
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
	const trapped = cycle.length > 0 && missed.length > 0;
	const trap: Trap | undefined = trapped
		? {
				members: [...cycleMembers]
					.map((index) => stops.find((stop) => stop.index === index))
					.filter((stop): stop is WalkStop => stop !== undefined),
				escapeFreed: capture.escapeFreed === true,
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
	const reordered = arrival.some(
		(index, at) => at > 0 && index < (arrival[at - 1] ?? -1),
	);

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

	lines.push(
		`Tabbed through ${firstPass.length} distinct stops` +
			`${looped ? ", then the order repeated" : ""}.`,
		"",
	);

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
			`  ${findings.missed.length} focusable things are stranded outside it.`,
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

	if (findings.missed.length > 0 && !findings.trap) {
		lines.push(
			`${findings.missed.length} focusable things were never reached:`,
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

	return lines.join("\n");
}
