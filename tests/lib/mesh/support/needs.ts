/**
 * Needs, cells and ties as the need-routing tests build them, shared by
 * the tests of routing in general and of routing by declared subjects.
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

/** A need routed where every cell is there unless `live` says not. */
export const routeNeed = (
	need: NeedAsked,
	reach: Omit<Reach, "live"> & Partial<Pick<Reach, "live">>,
) => routeOver(need, { live: () => true, ...reach });

/** Cells with the words each works on. */
export const cells = (held: Record<string, string[]>): Forager[] =>
	Object.entries(held).map(([address, words]) => ({ address, words }));

/** Ties as pairs of ends, each as strong as given, both ways. */
export const ties = (...pairs: [string, string, number][]): TieGraph => {
	const graph = new Map<string, { other: string; strength: number }[]>();
	for (const [one, other, strength] of pairs) {
		graph.set(one, [...(graph.get(one) ?? []), { other, strength }]);
		graph.set(other, [...(graph.get(other) ?? []), { other: one, strength }]);
	}
	return graph;
};
