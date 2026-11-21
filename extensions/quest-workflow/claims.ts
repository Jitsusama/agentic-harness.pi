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

import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	readdirSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hosted } from "../../lib/core/session/host.ts";
import {
	type SweptTrees,
	type TreeClaims,
	WORK_TREE_CLAIMS,
	WORK_TREES_SWEPT,
} from "../../lib/core/work/events.ts";
import { everyRealmsDir, whyRealmsUnlisted } from "../../lib/internal/paths.ts";
import { isId, prefixOf } from "../../lib/internal/quest/creation/id.ts";
import {
	type DiscoveryResult,
	discoverQuests,
	discoverQuestsAfresh,
	questsWalked,
} from "../../lib/internal/quest/discovery/discovery.ts";
import {
	FRONT_MATTER_INVALID,
	README_MISSING,
} from "../../lib/internal/quest/discovery/discovery-walk.ts";
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
 * The claims come at once from each store's last walk, which on a host
 * may predate another process's change by as long as nobody asked. An
 * asker that offers {@link TreeClaims.answering} waits as well on each
 * store signed afresh off the thread, whose trees are added when it
 * ends; one that doesn't hears only the last walk. When a store's disk
 * gives no answer in time, that wait rejects rather than pass an old
 * walk off as fresh: a sweep then takes nothing that round, since a
 * tree listed since would be in no claim. Plain pi walks every ask
 * afresh, so it offers the asker nothing more to wait on.
 */
export function answerTreeClaims(pi: ExtensionAPI, questsRoot: string): void {
	pi.events.on(WORK_TREE_CLAIMS, (data: unknown) => {
		const claims = data as TreeClaims;
		const into = claims.untilSpent ?? claims.paths;
		const stores = storesOf(questsRoot);
		// A store this host never walked is signed only off the thread,
		// below, for an asker that waits.
		claimFrom(
			stores.filter(questsWalked).map((store) => discoverQuests(store)),
			into,
		);
		if (!hosted()) return;
		claims.answering?.push(
			Promise.all(stores.map((store) => discoverQuestsAfresh(store))).then(
				(walks) => claimFrom(walks, into),
			),
		);
	});
}

/**
 * Every tree a live quest lists, in any realm, read from the quests on
 * disk: what a sweep in a process of its own holds until spent. Outside
 * a host each store is signed as it stands on every ask.
 */
export function liveQuestTrees(questsRoot: string): string[] {
	const paths: string[] = [];
	claimFrom(
		storesOf(questsRoot).map((store) => discoverQuests(store)),
		paths,
	);
	return paths;
}

/**
 * Why the quests can't all be read for their claims, or nothing: every
 * realm must be listed, the quests root this realm's config names must
 * be a folder, and every other realm's store that stands, or is a link,
 * must list, with every quest folder in each read. A store read as
 * empty, or a quest left out of it, claims nothing, so those quests'
 * trees would be taken as nobody's.
 */
export function whyQuestsUnread(questsRoot: string): string | undefined {
	const realms = whyRealmsUnlisted("data");
	if (realms !== undefined) return realms;
	for (const store of storesOf(questsRoot)) {
		let names: string[];
		try {
			const found = statSync(store, { throwIfNoEntry: false });
			// Another realm that never kept a quest has nothing to claim; one
			// whose store is a link to nothing may have quests elsewhere.
			const absent =
				found === undefined &&
				lstatSync(store, { throwIfNoEntry: false }) === undefined;
			if (absent && store !== questsRoot) continue;
			if (found?.isDirectory() !== true) return `the quests aren't at ${store}`;
			names = readdirSync(store);
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			return `the quests at ${store} can't be looked at: ${why}`;
		}
		const left = whyQuestLeftOut(store, names, discoverQuests(store));
		if (left !== undefined) return left;
	}
	return undefined;
}

/**
 * Why a quest folder in `store` is missing from `walk`, the walk the
 * claims read, or nothing when each is a folder the walk read or one
 * still being made. Folders are counted rather than errors read, since
 * the walk leaves some out with no error: a link, or a quest whose id
 * another folder's README also names, which takes its place.
 */
function whyQuestLeftOut(
	store: string,
	names: readonly string[],
	walk: DiscoveryResult,
): string | undefined {
	const walked = new Set(
		[...walk.index.quests.values()].map((quest) => quest.dir),
	);
	for (const name of names) {
		if (!isId(name) || prefixOf(name) !== "QEST") continue;
		const dir = join(store, name);
		if (walked.has(dir) || beingMade(dir)) continue;
		return `the quest at ${dir} can't be read for its claims: ${whyLeftOut(dir, walk)}`;
	}
	return undefined;
}

/** The file a quest is read from, beside the documents in its folder. */
const QUEST_README = "README.md";

/**
 * Whether `dir` is a quest still being made: a folder of its own with
 * no README yet, or an empty one, so it lists no trees.
 */
function beingMade(dir: string): boolean {
	try {
		if (!lstatSync(dir).isDirectory()) return false;
		const readme = statSync(join(dir, QUEST_README), { throwIfNoEntry: false });
		return readme === undefined || readme.size === 0;
	} catch {
		// A folder or README that can't be looked at may list any tree.
		return false;
	}
}

/** What kept the walk from reading the quest at `dir`, in a few words. */
function whyLeftOut(dir: string, walk: DiscoveryResult): string {
	const readme = join(dir, QUEST_README);
	try {
		if (lstatSync(dir).isSymbolicLink())
			return "it is a link, which the walk doesn't follow";
		accessSync(readme, constants.R_OK);
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		return `its README can't be read: ${why}`;
	}
	// The walk keeps one quest per id, the folder it read last.
	const taker = walk.index.quests.get(basename(dir));
	if (taker !== undefined && taker.dir !== dir) {
		return `the README at ${taker.dir} names its id, and took its place`;
	}
	const said = walk.errors.find(
		(error) => error.path === readme && error.message !== README_MISSING,
	);
	if (said?.message === FRONT_MATTER_INVALID) return said.message;
	// A folder named apart from its id is only left out when another
	// folder holds that id.
	if (said !== undefined) {
		return `its README names another folder's quest, which took its place: ${said.message}`;
	}
	return "the walk couldn't read its README, as when it changes during the walk";
}

/**
 * Push every tree a live quest in `walks` lists onto `into`, once, so
 * the fresh answer adds only what the last walk didn't hold.
 */
function claimFrom(walks: readonly DiscoveryResult[], into: string[]): void {
	for (const entry of liveQuests(walks)) {
		for (const tree of entry.doc.frontMatter.trees ?? []) {
			if (!into.includes(tree.path)) into.push(tree.path);
		}
	}
}

/**
 * Drop a tree a sweep took from every live quest that listed it, since
 * its folder is gone and a recut at its branch makes a new one. Logged
 * by the sweep itself, with the branch and the sessions that used it.
 * What it writes rests on which quests list a tree now, so it waits on
 * each store signed afresh, off a host's thread. Nothing awaits it, so
 * whatever goes wrong is said on stderr, never thrown: an unheard
 * rejection ends the process, and on a host every conversation in it.
 */
export function forgetSweptTrees(pi: ExtensionAPI, questsRoot: string): void {
	pi.events.on(WORK_TREES_SWEPT, (data: unknown) => {
		forgetTrees(questsRoot, (data as SweptTrees).paths).catch(
			(error: unknown) => {
				sayForgetFailed("any quest", error);
			},
		);
	});
}

/**
 * Drop each tree in `paths` from every live quest that lists it, as
 * {@link forgetSweptTrees} does for a host's sweep, for a sweep in a
 * process of its own that waits on it before it ends.
 */
export function forgetTrees(
	questsRoot: string,
	paths: readonly string[],
): Promise<void> {
	return forgetTaken(questsRoot, new Set(paths));
}

/**
 * Drop each tree in `taken` from every live quest that lists it, each
 * quest's write on its own, so one quest's locked or vanished folder
 * leaves the rest forgetting. A tree whose folder is back by the time
 * the walk ends was cut again at its path while the quest was signed,
 * so it stays listed.
 */
async function forgetTaken(
	questsRoot: string,
	taken: ReadonlySet<string>,
): Promise<void> {
	const walks: DiscoveryResult[] = [];
	for (const store of storesOf(questsRoot)) walks.push(await signed(store));
	for (const entry of liveQuests(walks)) {
		for (const tree of entry.doc.frontMatter.trees ?? []) {
			if (!taken.has(tree.path) || existsSync(tree.path)) continue;
			try {
				// A write refused says why as a throw does, and stops the second.
				const removed = removeTreeFromQuest(entry.dir, tree.path);
				if (!removed.ok) throw new Error(removed.reason);
				const cleared = setPendingPrune(entry.dir, null, {
					clearPath: tree.path,
				});
				if (!cleared.ok) throw new Error(cleared.reason);
			} catch (error) {
				sayForgetFailed(entry.doc.frontMatter.id, error);
			}
		}
	}
}

/**
 * Say on stderr, a host's journal, that a swept tree stays listed in
 * `where`, which claims a folder that is gone until its quest prunes it.
 */
function sayForgetFailed(where: string, error: unknown): void {
	const why = error instanceof Error ? error.message : String(error);
	process.stderr.write(
		`[quest-workflow] couldn't forget swept trees in ${where}: ${why}\n`,
	);
}

/**
 * `store` signed afresh, or as its last walk stands when its disk gave
 * no answer in time: a tree left listed is dropped by the next sweep.
 */
async function signed(store: string): Promise<DiscoveryResult> {
	try {
		return await discoverQuestsAfresh(store);
	} catch (error) {
		// The disk didn't answer the signing; the last walk still stands,
		// and the journal says so, since its trees may be a while old.
		const why = error instanceof Error ? error.message : String(error);
		process.stderr.write(
			`[quest-workflow] tree claims in ${store} answer its last walk: ${why}\n`,
		);
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
