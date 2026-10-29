/**
 * Where a quest's tree is, as seen from the machine reading the quest.
 *
 * A quest shared between machines (mycelium's share) lists every
 * machine's trees in one README, each path written for the machine
 * that reads it. A tree cut on optimus then reads, on a Mac, as a path
 * that isn't there, and before trees named their machine the Mac took
 * it for a tree released by hand and dropped its record, which left
 * optimus's checkout owned by no quest. So every verb that acts on a
 * tree asks this first, and acts only on this machine's.
 */

import { existsSync } from "node:fs";
import { hostname } from "node:os";
import type { QuestTree } from "../../quest/types.ts";

/**
 * - `here`: this machine's, to act on.
 * - `elsewhere`: another machine's, named by its `host`; shown, never
 *   touched.
 * - `unplaced`: it names no machine and its folder isn't here, so it
 *   may be on another machine or gone, and nothing here can tell which.
 */
export type TreePlace = "here" | "elsewhere" | "unplaced";

/** How a reader sees the machine and its disk, given in tests. */
export interface PlaceSight {
	readonly host?: string;
	readonly exists?: (path: string) => boolean;
}

/**
 * Where a tree is. One that names no machine is this machine's when
 * its folder is here, which keeps every README written before trees
 * named their machine working where it was written.
 */
export function treePlace(tree: QuestTree, sight: PlaceSight = {}): TreePlace {
	const host = sight.host ?? hostname();
	if (tree.host !== undefined) return tree.host === host ? "here" : "elsewhere";
	return (sight.exists ?? existsSync)(tree.path) ? "here" : "unplaced";
}

/** The trees this machine acts on, in the order the quest lists them. */
export function treesHere(
	trees: readonly QuestTree[],
	sight: PlaceSight = {},
): QuestTree[] {
	return trees.filter((tree) => treePlace(tree, sight) === "here");
}

/** A tree as this machine records it: naming this machine. */
export function placedHere(tree: QuestTree, sight: PlaceSight = {}): QuestTree {
	return { ...tree, host: sight.host ?? hostname() };
}

/**
 * The trees with this machine named on every untagged one whose folder
 * is here, or undefined when none needed it, so a write that changes
 * nothing else doesn't rewrite the README for it.
 */
export function withHostsBackfilled(
	trees: readonly QuestTree[],
	sight: PlaceSight = {},
): QuestTree[] | undefined {
	let changed = false;
	const next = trees.map((tree) => {
		if (tree.host !== undefined || treePlace(tree, sight) !== "here")
			return tree;
		changed = true;
		return placedHere(tree, sight);
	});
	return changed ? next : undefined;
}
