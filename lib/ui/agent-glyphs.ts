/**
 * How anything that spawns an agent draws what it spawned.
 *
 * A fan-out of subagents and a round of reviewers are the same event
 * on screen: several models sent away at once, each in one of five
 * states. They were drawn in two vocabularies nobody had compared,
 * and both had gone wrong in the way the ownership gate exists to
 * catch. The fleet drew a pending subagent as a hollow diamond and a
 * running one as a filled one, which are the marks quests use for a
 * sidequest and a subquest. Review had already been bitten by exactly
 * that and moved off diamonds; the fleet's copy was never in the
 * gate's list, so nothing caught it making the same mistake.
 *
 * So the marks live here, in neither surface, for the reason `exec`
 * and `remote` are their own modules: both need them and neither owns
 * them. A surface that spells one itself is a surface that will drift,
 * and a package test refuses one.
 *
 * Marks rather than a shape family, and that is forced rather than
 * chosen. Every geometric family is allocated already, and the marks
 * outside them that a terminal can actually draw are few: the three
 * monospace fonts shipped on macOS were read directly, and of the
 * candidates only these are present in more than one of them. The
 * hexagons this first reached for are in none of the three, so they
 * would have fallen back to another font and taken the column
 * alignment of every row with them.
 *
 * Which is the honest reason the states split the way they do. How far
 * along a run is gets a dot and an arrow, and how it ended gets a
 * tick, a dash and a cross, because those are the marks that exist.
 */

/** Where one spawned agent has got to. */
export type AgentState =
	| "pending"
	| "running"
	| "done"
	| "cancelled"
	| "failed";

/**
 * The mark for each state, and the only place these five are spelled.
 *
 * The cross is deliberately the one review already uses for a failed
 * anything, under that same name, because two marks for failure in one
 * session is the fault this set exists to end rather than a detail.
 */
export const AGENT_GLYPH: Record<AgentState, string> = {
	// Hollow and small: accepted, nothing spent on it yet.
	pending: "\u25e6",
	// Sent away, which is the whole of what a spawned agent is doing.
	running: "\u2192",
	done: "\u2713",
	// Neither a tick nor a cross, because a run somebody stopped did not
	// pass and did not fail. The fleet used a middle dot, which is the
	// separator between every field on the same line, so the mark for a
	// cancelled subagent and the punctuation beside it were one glyph.
	cancelled: "\u2212",
	failed: "\u2715",
};
