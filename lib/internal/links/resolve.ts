/**
 * The link a click on pi's screen opens, read from the plain text
 * under it.
 *
 * The text is read as `screen.ts` puts it together and searched for a
 * place the clicked character falls in, the widest first, and the
 * first that names somewhere real wins. Rows joined without reaching
 * the screen's edge may be two words that only line up, so they are
 * trusted only for a path, which must exist, and a quest id, which
 * must be found: a URL or a GitHub reference read across them could
 * be a word too long, and is read from the clicked row alone.
 */

import { type PlaceKind, placesAt } from "./places.ts";
import { textsAtClick } from "./screen.ts";
import { type PlaceWorld, targetOf } from "./targets.ts";

/** The kinds a join short of the edge may be read as, since each is checked. */
const CHECKED: ReadonlySet<PlaceKind> = new Set(["path", "quest-id"]);

/** The URL a click at cell (`x`, `y`) opens, or nothing when it names no place. */
export function linkAtClick(
	screen: readonly string[],
	x: number,
	y: number,
	columns: number,
	world: PlaceWorld,
): string | undefined {
	for (const clicked of textsAtClick(screen, x, y, columns)) {
		for (const place of placesAt(clicked.text, clicked.index)) {
			if (clicked.joined === "column" && !CHECKED.has(place.kind)) continue;
			const target = targetOf(place, world);
			if (target) return target;
		}
	}
	return undefined;
}
