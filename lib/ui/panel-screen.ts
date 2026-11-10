/**
 * The screen a panel is drawn on, while it is drawn.
 *
 * Pi sizes everything it draws from its own terminal, and a panel sizes
 * its content the same way: how many rows its body gets, and the width
 * its words wrap at. Read from the process's stdout, that is right only
 * when pi's terminal is the process's tty. A host runs many pi screens
 * in one process with no tty of its own, each drawn to whoever views it,
 * so there the panel has to read the terminal of the screen it is on.
 *
 * Both mounts, the overlay and the dock, draw a panel and hand it keys
 * inside `onPanelScreen` with pi's terminal, so the helpers here answer
 * for that screen, and for the process's tty only outside any mount. It
 * is module state for the reason the panel room is: the mount that sets
 * it and the helper that reads it are the same copy of this library,
 * and each draw sets and restores it before anything else can run.
 */

/** What a panel needs to know of the screen it is drawn on. */
export interface PanelScreen {
	/** The screen's height, in rows. */
	readonly rows: number;
	/** The screen's width, in columns. */
	readonly columns: number;
}

/** What the rows fall back to with neither a screen nor a tty to read. */
const FALLBACK_ROWS = 40;

let current: PanelScreen | undefined;

/** Runs `draw` on `screen`, and puts the last one back after. */
export function onPanelScreen<T>(screen: PanelScreen, draw: () => T): T {
	const before = current;
	current = screen;
	try {
		return draw();
	} finally {
		current = before;
	}
}

/** The height of the screen a panel is drawn on now, or of the tty. */
export function screenRows(): number {
	return current?.rows || process.stdout.rows || FALLBACK_ROWS;
}

/**
 * The width of the screen a panel is drawn on now, or of the tty; for
 * neither, undefined, which each caller answers with its own fallback.
 */
export function screenColumns(): number | undefined {
	return current?.columns || process.stdout.columns || undefined;
}
