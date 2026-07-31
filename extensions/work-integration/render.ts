/**
 * How the working layer draws itself.
 *
 * Geometry, not emoji, for the same reason the review tools use
 * it: a glyph that renders as a coloured square on one terminal
 * and a blank box on another is not a signal. Squares here rather
 * than the review tools' diamonds, because a tree is a place on
 * disk and a change is a thing said about one.
 */

import { displayPath } from "../../lib/ui/index.js";

/** Glyphs for the working layer. */
export const GLYPH = {
	// Squares: a tree, which is a place. Filled is one that exists
	// and is held, hollow is one merely named.
	tree: "\u25a0",
	named: "\u25a1",

	// A snapshot is pinned rather than checked out, so it reads as
	// a point instead of an area.
	snapshot: "\u25a4",

	// State of the work inside a tree, in the same family as the tree
	// itself but smaller, since it describes what is inside one rather
	// than being one. A tree with changes in it is the one case a caller
	// must not be allowed to overlook.
	//
	// These were an open and a filled circle, which quests use for a
	// status and the TDD phase uses for a progression. That made a filled
	// circle mean a concluded quest, a passing test, and a tree with
	// uncommitted work in it: two of those are good news and the third is
	// the one thing here you must not miss.
	clean: "\u25ab",
	dirty: "\u25aa",

	// A stack, borrowed from the review tools on purpose: a stack of
	// branches and a stack of changes are the same idea seen from two
	// sides, and giving them separate marks would say they are not.
	// The glyph check permits this because both domains call it a stack;
	// what it refuses is one mark meaning two different things.
	stack: "\u2261",

	// Refusals, matching the review tools so the two surfaces do
	// not disagree about what a refusal looks like.
	refused: "\u2298",
} as const;

/** One held tree, as a line. */
export function treeLine(
	held: {
		identity: { key: string };
		path: string;
		providerId: string;
	},
	/**
	 * Whether this session cut it.
	 *
	 * Said because the two cases want different care. A tree from an earlier
	 * session may have somebody's uncommitted work in it that this session knows
	 * nothing about, so it is the one to read `status` on before touching, and a
	 * listing that presents both identically is the reason nobody would.
	 */
	cutHere = true,
): string {
	const from = cutHere ? "" : " · from an earlier session";
	return `${GLYPH.tree} ${held.identity.key}${from}\n   ${displayPath(held.path)} · ${held.providerId}`;
}
