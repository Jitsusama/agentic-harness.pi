/**
 * Answering the working layer when it asks who holds a tree, and
 * hearing from it when a sweep took one.
 *
 * A quest cuts worktrees and records them on its frontmatter, which
 * the working layer's broker knows nothing about. From git's side the
 * two are identical: a directory, a branch, and no record in the
 * broker's memory. So the working layer's reclamation would happily
 * take back a tree a live quest is holding, and the first run of it
 * against a real repository did exactly that.
 *
 * The fix belongs here rather than there. The working layer must not
 * learn what a quest is, and asking over the bus means any other
 * package that cuts trees can answer the same question without either
 * side importing the other.
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type SweptTrees,
	type TreeClaims,
	WORK_TREE_CLAIMS,
	WORK_TREES_SWEPT,
} from "../../lib/core/work/events.ts";
import { everyRealmsDir } from "../../lib/internal/paths.ts";
import {
	type DiscoveryResult,
	discoverQuests,
	discoverQuestsAfresh,
} from "../../lib/internal/quest/discovery/discovery.ts";
import { isSealedStatus } from "../../lib/internal/quest/status.ts";
import {
	removeTreeFromQuest,
	setPendingPrune,
} from "../../lib/internal/quest/workspace/trees.ts";

/**
 * Answer the working layer's question about held trees.
 *
 * Only a live quest claims the trees it lists. A concluded or retired
 * one hands them to the working layer's own judgement, which reclaims a
 * tree only when it is clean and trunk holds its branch, and reports
 * the rest rather than taking them. Claiming them for good, waiting on
 * a `tree-release` nobody runs once a quest is over, kept 102 finished
 * trees on one machine's disk, none of them ever offered back.
 *
 * A live quest holds a tree only while it is still work, too: once
 * every session that used it has ended, an unattended sweep may take it
 * by the same rules, clean and in trunk or pushed and left a day. A
 * quest lists the trees it ever cut, and those claims alone kept 220
 * ended trees of 456 on one machine on 11 November. So its trees go in
 * the asker's {@link TreeClaims.untilSpent} when it offers that list,
 * and are held for good only by an asker that doesn't.
 *
 * The asker hears the claims as the event fires, so they come from each
 * store's last walk, as a host brings it up to date between signings:
 * a tree another process listed in the last few seconds can go
 * unclaimed. A sweep takes only a tree that is clean and in trunk, or
 * pushed and left a day, so a tree cut that recently loses nothing.
 */
export function answerTreeClaims(pi: ExtensionAPI, questsRoot: string): void {
	pi.events.on(WORK_TREE_CLAIMS, (data: unknown) => {
		const claims = data as TreeClaims;
		const into = claims.untilSpent ?? claims.paths;
		const walks = storesOf(questsRoot).map((store) => discoverQuests(store));
		for (const entry of liveQuests(walks)) {
			for (const tree of entry.doc.frontMatter.trees ?? []) {
				into.push(tree.path);
			}
		}
	});
}

/**
 * Drop a tree a sweep took from every live quest that listed it, since
 * its folder is gone and a recut at its branch makes a new one. Logged
 * by the sweep itself, with the branch and the sessions that used it.
 * What it writes rests on which quests list a tree now, so it waits on
 * each store signed afresh, off a host's thread.
 */
export function forgetSweptTrees(pi: ExtensionAPI, questsRoot: string): void {
	pi.events.on(WORK_TREES_SWEPT, (data: unknown) => {
		void forgetTaken(questsRoot, new Set((data as SweptTrees).paths));
	});
}

/** Drop each tree in `taken` from every live quest that lists it. */
async function forgetTaken(
	questsRoot: string,
	taken: ReadonlySet<string>,
): Promise<void> {
	const walks: DiscoveryResult[] = [];
	for (const store of storesOf(questsRoot)) walks.push(await signed(store));
	for (const entry of liveQuests(walks)) {
		for (const tree of entry.doc.frontMatter.trees ?? []) {
			if (!taken.has(tree.path)) continue;
			removeTreeFromQuest(entry.dir, tree.path);
			setPendingPrune(entry.dir, null, { clearPath: tree.path });
		}
	}
}

/**
 * `store` signed afresh, or as its last walk stands when its disk gave
 * no answer in time: a tree left listed is dropped by the next sweep.
 */
async function signed(store: string): Promise<DiscoveryResult> {
	try {
		return await discoverQuestsAfresh(store);
	} catch {
		// The disk didn't answer the signing; the last walk still stands.
		return discoverQuests(store);
	}
}

/**
 * Every realm's quest store. Trees are the machine's, so a sweep in
 * one realm would otherwise take another's as nobody's.
 */
function storesOf(questsRoot: string): string[] {
	const realms = everyRealmsDir("data", "quest-workflow").map((dir) =>
		join(dir, "quests"),
	);
	return [...new Set([questsRoot, ...realms])];
}

/** Every unsealed quest in `walks`. */
function* liveQuests(walks: readonly DiscoveryResult[]) {
	for (const { index } of walks) {
		for (const entry of index.quests.values()) {
			if (!isSealedStatus(entry.doc.frontMatter.status)) yield entry;
		}
	}
}
