/**
 * The cell a quest's work split from, kept in its README's `split-from`
 * front matter: the cell that sprouted it, by mesh address, so its
 * presence says `lineage.split_from` and mycelium's forage draws the
 * split. The map reads it from both ends, so the cell it split from
 * needs to say nothing of it.
 *
 * Only a quest a sprout made from a cell holds one. A sprout the person
 * starts, from the launcher, has no cell to split from, and a live quest
 * a sprout joined was there before the ask. It is the sprouter's claim,
 * as its seed's words are, and grants nothing.
 */

/** A mesh address as the node's forage::is_address takes one. */
const ADDRESS = /^[A-Za-z0-9]{1,32}$/u;

/** The front matter key a quest's README holds it under. */
export const SPLIT_FROM = "split-from";

/**
 * The address `said` names, as a README's `split-from` or a presence's
 * `lineage.split_from` holds it, or nothing when it names no cell.
 */
export function splitFromOf(said: unknown): string | undefined {
	if (typeof said !== "string") return undefined;
	const address = said.trim();
	return ADDRESS.test(address) ? address : undefined;
}
