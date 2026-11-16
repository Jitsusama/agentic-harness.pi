/**
 * What the keyboard walk captures and what it finds: each stop's
 * focus styles, the candidates that could take focus, and the
 * traps, jumps, faint indicators and stranded controls an analysis
 * reports.
 *
 * Kept apart from the walk's judgement and its rendering because
 * both read these shapes, and they change when the capture gains a
 * fact, not when a rule or a sentence does.
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
	/** Inside an open dialog that is holding focus on purpose. */
	readonly inModal?: boolean;
	/**
	 * The named radio group it belongs to. Tab stops once in a group
	 * and arrow keys move within it, so one stop reaches them all.
	 */
	readonly group?: string;
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
