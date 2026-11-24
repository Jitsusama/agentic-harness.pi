/**
 * Needs, cells and ties as the need-routing tests build them, shared by
 * the tests of routing in general, of routing by declared subjects and
 * of subjects naming a service unit.
 */

import {
	type Forager,
	type NeedAsked,
	type Reach,
	routeNeed as routeOver,
	type TieGraph,
} from "../../../../lib/mesh/need-route.ts";

/** The moment every need here is asked at. */
export const AT = Date.UTC(2026, 10, 17, 19, 0, 0);

/** A need asked by `asker` about `words`, at a fixed moment. */
export const asked = (asker: string, ...words: string[]): NeedAsked => ({
	need: `${asker}/1`,
	asker,
	words,
	at: AT,
});

/**
 * How many needs, each its own id, a sharing out is judged over: hubs
 * as deep and as telling are shared among needs by a hash, so one need
 * alone can't tell a hub chosen from a tie.
 */
export const SHARED_NEEDS = 40;

/** `SHARED_NEEDS` needs from `asker` about `words`, each its own id. */
export const numbered = (asker: string, ...words: string[]): NeedAsked[] =>
	Array.from({ length: SHARED_NEEDS }, (_, at) => ({
		...asked(asker, ...words),
		need: `${asker}/${at}`,
	}));

/** A need routed where every cell is there unless `live` says not. */
export const routeNeed = (
	need: NeedAsked,
	reach: Omit<Reach, "live"> & Partial<Pick<Reach, "live">>,
) => routeOver(need, { live: () => true, ...reach });

/** Cells with the words each works on. */
export const cells = (held: Record<string, string[]>): Forager[] =>
	Object.entries(held).map(([address, words]) => ({ address, words }));

/**
 * Ties as pairs of ends, each as strong as given, both ways, last heard
 * when given or else when every need here is asked, and spoken on today
 * by the ends given, or else by both.
 */
export const ties = (
	...pairs: [string, string, number, number?, [boolean, boolean]?][]
): TieGraph => {
	const graph = new Map<
		string,
		{ other: string; strength: number; heard: number; spoke: boolean }[]
	>();
	const both: [boolean, boolean] = [true, true];
	for (const [one, other, strength, heard = AT, spoke = both] of pairs) {
		const [first, second] = spoke;
		graph.set(one, [
			...(graph.get(one) ?? []),
			{ other, strength, heard, spoke: first },
		]);
		graph.set(other, [
			...(graph.get(other) ?? []),
			{ other: one, strength, heard, spoke: second },
		]);
	}
	return graph;
};
