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
 * Hexagons, because every other family is taken and a spawned agent
 * deserves to be recognisable at a glance as neither a quest nor a
 * review nor a tree. A hollow one is waiting, a full one is working.
 * The three settled states are marks rather than shapes, because how
 * a thing ended is a different question from how far along it is.
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
 * The cross is the one mark shared with the review surface, under the
 * same name and meaning it already had there, so review's own failed
 * mark is taken from here rather than written twice.
 */
export const AGENT_GLYPH: Record<AgentState, string> = {
	pending: "\u2b21",
	running: "\u2b22",
	done: "\u2713",
	// Neither a tick nor a cross, because a run somebody stopped did not
	// pass and did not fail. The fleet used a middle dot, which is the
	// separator between every field on the same line, so the mark for a
	// cancelled subagent and the punctuation beside it were one glyph.
	cancelled: "\u2212",
	failed: "\u2715",
};
