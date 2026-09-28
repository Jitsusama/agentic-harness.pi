/**
 * What a panel is told about the room it is drawn in, while it is drawn.
 *
 * An overlay panel sizes itself off the terminal: a share of its height
 * for the content, the rest for chrome. A panel docked above the editor
 * shares the terminal with the transcript and every other widget, so it
 * has to be told how many rows it has, and it has to be told again for
 * every key it handles, since a scroll is clamped against the height it
 * was last drawn at. It also has to be told when it has been answered, so
 * it can draw itself once more as the record it leaves in the transcript:
 * no key hints and no scrollbar, since nothing reaches or scrolls a record.
 *
 * The primitives read this through `contentBudget`, `renderScrollRegion`,
 * `renderFooter` and `renderNoteEditor`, and nothing else in them changes,
 * which is why a panel needs no edits to be docked. It is module state
 * rather than a parameter for the same reason, and module state is enough:
 * the mount that sets it and the primitive that reads it are always the
 * same copy of this library, since the primitive calls its own mount.
 */

/** The room one panel is being drawn in, or answered from. */
export interface PanelRoom {
	/** The terminal's height. */
	readonly rows: number;
	/** Rows the panel may take in all, or infinity for as many as it wants. */
	readonly allot: number;
	/** Set once the panel has been answered, to draw it as its record. */
	readonly answered?: boolean;
	/** The chord that moves between the panel and the editor, for its hints. */
	readonly hop?: string;
	/** Whether the panel holds the keyboard, which changes what its hints say. */
	readonly focused?: boolean;
	/**
	 * Written by the panel while it draws: what its note editor holds, when
	 * it is open, so a one-row form can say that instead of the decision.
	 */
	editing?: string;
}

let current: PanelRoom | undefined;

/** Runs `draw` with `room` as the room, and puts the last one back after. */
export function withPanelRoom<T>(room: PanelRoom, draw: () => T): T {
	const before = current;
	current = room;
	try {
		return draw();
	} finally {
		current = before;
	}
}

/** The room the panel being drawn now has, or undefined for an overlay. */
export function panelRoom(): PanelRoom | undefined {
	return current;
}
