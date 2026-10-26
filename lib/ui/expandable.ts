/**
 * A transcript entry that opens and closes on a click, the way pi's
 * own tool results and compaction summaries do.
 *
 * Pi hands a renderer one `expanded`, the session-wide one that its
 * expand key flips for everything at once. Its own entries also flip
 * one at a time on a left click, and the harness's collapsed lines
 * did not, so the one way to read a single mesh message in full was
 * to open every entry in the session. Here a click flips the entry it
 * lands on, and the expand key still sets them all, as it does for
 * pi's: whichever happened last wins.
 *
 * Pi builds the entry's component again whenever it is invalidated (a
 * theme change, a resize), so what a click opened is kept against the
 * message or entry itself rather than in the component, and a resize
 * does not close it.
 *
 * Only a click is taken. A press passes through, so dragging across
 * the line still selects its text, and pi turns a press and release
 * in one place into the click.
 *
 * Pi draws every entry in the transcript on every frame, so an entry
 * keeps the lines it last drew and draws them again until its width or
 * its state changes. Without that, each frame parsed every guard
 * report's markdown again, and a session's frames grew dearer with
 * every entry it had shown. So `lines` must give the same lines for the
 * same width and state, as a renderer of a finished entry does.
 */

import { type Component, MouseRegion } from "@earendil-works/pi-tui";

/** The lines of an entry at a width, open or closed. */
export type ExpandableLines = (width: number, expanded: boolean) => string[];

/** What one entry's clicks have made of it, against pi's own setting. */
interface Opened {
	/** Pi's session-wide setting when this was decided. */
	readonly setting: boolean;
	expanded: boolean;
}

const opened = new WeakMap<object, Opened>();

/**
 * The entry `key` (the message or entry pi rendered) as a component
 * that a left click opens and closes.
 */
export function expandable(
	key: object,
	setting: boolean,
	lines: ExpandableLines,
): Component {
	const kept = opened.get(key);
	// The expand key was pressed since the last click: it sets them all.
	const state =
		kept && kept.setting === setting ? kept : { setting, expanded: setting };
	opened.set(key, state);
	let drawn: { width: number; expanded: boolean; lines: string[] } | undefined;
	return new MouseRegion(
		{
			render: (width: number) => {
				if (drawn?.width !== width || drawn.expanded !== state.expanded) {
					const expanded = state.expanded;
					drawn = { width, expanded, lines: lines(width, expanded) };
				}
				return drawn.lines;
			},
			invalidate: () => {
				drawn = undefined;
			},
		},
		(event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			state.expanded = !state.expanded;
			return { handled: true };
		},
	);
}
