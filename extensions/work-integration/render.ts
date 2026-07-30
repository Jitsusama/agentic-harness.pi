/**
 * How the working layer draws itself.
 *
 * Geometry, not emoji, for the same reason the review tools use
 * it: a glyph that renders as a coloured square on one terminal
 * and a blank box on another is not a signal. Squares here rather
 * than the review tools' diamonds, because a tree is a place on
 * disk and a change is a thing said about one.
 */

/** Glyphs for the working layer. */
export const GLYPH = {
	// Squares: a tree, which is a place. Filled is one that exists
	// and is held, hollow is one merely named.
	tree: "\u25a0",
	named: "\u25a1",

	// A snapshot is pinned rather than checked out, so it reads as
	// a point instead of an area.
	snapshot: "\u25aa",

	// State of the work inside a tree. A tree with changes in it
	// is the one case a caller must not be allowed to overlook.
	clean: "\u25cb",
	dirty: "\u25cf",

	// Refusals, matching the review tools so the two surfaces do
	// not disagree about what a refusal looks like.
	refused: "\u2298",
} as const;

/** One held tree, as a line. */
export function treeLine(held: {
	identity: { key: string };
	path: string;
	providerId: string;
}): string {
	return `${GLYPH.tree} ${held.identity.key}\n   ${held.path} · ${held.providerId}`;
}
