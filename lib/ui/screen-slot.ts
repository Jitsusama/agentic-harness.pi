/**
 * What one screen shares among every copy of this library: its gate
 * queue, its dock, its open panels and its panel height.
 *
 * On pi there is one screen, so each lives on `globalThis` under
 * `Symbol.for(name)`, where the first copy to load installs it and every
 * later copy joins it, whatever version installed it. A host holds a
 * screen for each conversation, and one process-global would let a gate
 * in one conversation queue behind another's, a hop reach another's
 * widget, a zoom size every screen and a `/new` close every panel. So
 * hosted, each conversation has its own, under the same name, which its
 * close frees; copies still join on the name, since the session's slots
 * are shared by every copy too.
 */

import { sessionCell } from "../core/session/index.ts";

/**
 * The value this screen keeps under `name`, installing `create()`'s when
 * none is there, or when what is there fails `joins`, the check every
 * copy agrees on. Hosted, the screen is the ambient conversation's; a
 * call outside any is refused rather than given another's.
 */
export function screenShared<T>(
	name: string,
	joins: (value: unknown) => value is T,
	create: () => T,
): T {
	const cell = sessionCell<unknown>(name);
	const found = cell.get();
	if (joins(found)) return found;
	const made = create();
	cell.set(made);
	return made;
}

/** The value this screen keeps under `name`, if any. */
export function screenValue(name: string): unknown {
	return sessionCell<unknown>(name).get();
}

/** Keep `value` under `name` for this screen. */
export function keepOnScreen(name: string, value: unknown): void {
	sessionCell<unknown>(name).set(value);
}
