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
import { basename, join, sep } from "node:path";
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
	type QuestEntry,
	questsWalked,
} from "../../lib/internal/quest/discovery/discovery.ts";
import {
	FRONT_MATTER_INVALID,
	README_MISSING,
} from "../../lib/internal/quest/discovery/discovery-walk.ts";
import { isSealedStatus } from "../../lib/internal/quest/status.ts";
import { treesHere } from "../../lib/internal/quest/workspace/tree-place.ts";
import {
	forgetBranchesFromQuest,
	removeTreeFromQuest,
	setPendingPrune,
} from "../../lib/internal/quest/workspace/trees.ts";
import type { QuestTree } from "../../lib/quest/types.ts";

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
 * Of those, a quest lets an unattended sweep's idle rules take every
 * tree it lists on this machine in a known repository but that
 * repository's newest whose folder stands, which holds the one its
 * session reopens in, as the sweep ruling of 24 November keeps; it
 * names them in {@link TreeClaims.idleMayTake} when the asker
 * offers that list. A quest's older trees alone kept every idle worktree
 * of an open quest: 24 clean, pushed and day-idle trees on 26 November.
 *
 * The claims come at once from each store's last walk, which on a host
 * may predate another process's change by as long as nobody asked. An
 * asker that offers {@link TreeClaims.answering} waits as well on each
 * store signed afresh off the thread, whose trees are added when it
 * ends; one that doesn't hears only the last walk. When a store's disk
 * gives no answer in time, that wait rejects rather than pass an old
 * walk off as fresh: a sweep then takes nothing that round, since a
 * tree listed since would be in no claim. Plain pi walks every ask
 * afresh, so it offers the asker nothing more to wait on. A walk that
 * leaves out a quest, as when its README changes during it, with no
 * earlier walk to hold for it, names no tree for idle rules to take,
 * on a host or off it: that quest may list any of them as its newest.
 * The left-out quest's own trees are in no claim at all, which is why
 * the outside sweep refuses to run while any quest can't be read.
 */
export function answerTreeClaims(pi: ExtensionAPI, questsRoot: string): void {
	pi.events.on(WORK_TREE_CLAIMS, (data: unknown) => {
		const claims = data as TreeClaims;
		const into = claims.untilSpent ?? claims.paths;
		const stores = storesOf(questsRoot);
		// A store this host never walked is signed only off the thread,
		// below, for an asker that waits.
		const walked = stores.filter(questsWalked);
		const walks = walked.map((store) => discoverQuests(store));
		const last = claimFrom(walks, into, claims.idleMayTake);
		if (!hosted() || claims.answering === undefined) {
			if (anyLeftOut(walked, walks)) claims.idleMayTake?.splice(0);
			return;
		}
		claims.answering.push(
			Promise.all(stores.map((store) => discoverQuestsAfresh(store))).then(
				(walks) => {
					claimFrom(walks, into, claims.idleMayTake, last);
					// The last walk holds the trees of a quest it read; one
					// neither walk read may hold any.
					if (anyLeftOut(stores, walks, last)) claims.idleMayTake?.splice(0);
				},
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
	return liveQuestClaims(questsRoot).untilSpent;
}

/** What the live quests hold until spent, and which of it idle rules may take. */
export interface QuestTreeClaims {
	untilSpent: string[];
	idleMayTake: string[];
}

/**
 * Every tree a live quest lists, as {@link liveQuestTrees} reads them,
 * and of those the ones idle rules may take, from one walk, so the two
 * lists tell of the same moment.
 */
export function liveQuestClaims(questsRoot: string): QuestTreeClaims {
	const claims: QuestTreeClaims = { untilSpent: [], idleMayTake: [] };
	const stores = storesOf(questsRoot);
	const walks = stores.map((store) => discoverQuests(store));
	claimFrom(walks, claims.untilSpent, claims.idleMayTake);
	// A quest the walk left out may hold any tree as its newest.
	if (anyLeftOut(stores, walks)) claims.idleMayTake.length = 0;
	return claims;
}

/**
 * Whether any quest folder in `stores` is missing from its walk, the one
 * at the same place in `walks` that the claims read, and from `held`, an
 * earlier walk's lists, or a store that stands can't be listed, since it
 * may hold any quest.
 */
function anyLeftOut(
	stores: readonly string[],
	walks: readonly DiscoveryResult[],
	held?: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
	return stores.some((store, at) => {
		const walk = walks[at];
		let names: string[];
		try {
			names = readdirSync(store);
		} catch {
			// A store that isn't there holds no quest to leave out.
			return lstatSync(store, { throwIfNoEntry: false }) !== undefined;
		}
		return (
			walk === undefined ||
			whyQuestLeftOut(store, names, walk, held) !== undefined
		);
	});
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
	held?: ReadonlyMap<string, unknown>,
): string | undefined {
	const walked = new Set(
		[...walk.index.quests.values()].map((quest) => quest.dir),
	);
	for (const name of names) {
		if (!isId(name) || prefixOf(name) !== "QEST") continue;
		const dir = join(store, name);
		if (walked.has(dir) || held?.has(dir) || beingMade(dir)) continue;
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
	const said = walk.errors.find(
		(error) => error.path === readme && error.message !== README_MISSING,
	);
	// A README that won't parse is never indexed, so nothing took its
	// place, whichever folder holds its id.
	if (said?.message === FRONT_MATTER_INVALID) return said.message;
	// The walk keeps one quest per id, the folder it read last.
	const taker = walk.index.quests.get(basename(dir));
	if (taker !== undefined && taker.dir !== dir) {
		return `the README at ${taker.dir} names its id, and took its place`;
	}
	// A folder named apart from its id is only left out when another
	// folder holds that id.
	if (said !== undefined) {
		return `its README names another folder's quest, which took its place: ${said.message}`;
	}
	return "the walk couldn't read its README, as when it changes during the walk";
}

/**
 * Push every tree a live quest in `walks` lists onto `into`, once, so
 * the fresh answer adds only what the last walk didn't hold, and onto
 * `mayTake`, when it is given, each of its trees here that isn't the
 * newest of its repository. A quest adds a tree to the end of its list
 * as it cuts it, so a repository's last whose folder stands is its
 * newest: one already gone leaves the tree before it to its session.
 * Each quest keeps every other tree it lists, such as one whose
 * repository isn't known, and a tree any live quest keeps is never
 * named, so one quest letting a tree go never overrides another's
 * hold. One an earlier walk named that this one keeps is taken back.
 * A quest `before`, an earlier walk of the same ask, saw listing a tree
 * keeps it, the older ones it let go then included, when this walk
 * couldn't read that quest, as when its README changes during the walk:
 * what it would say now is unknown. A tree any of the quest's sessions
 * started in is kept too, newest or not, since reopening that session
 * finds its log only there. Says what each quest walked lists.
 */
function claimFrom(
	walks: readonly DiscoveryResult[],
	into: string[],
	mayTake?: string[],
	before?: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
	const kept = new Set<string>();
	const lists = new Map<string, Set<string>>();
	const older: string[] = [];
	for (const entry of liveQuests(walks)) {
		const trees = entry.doc.frontMatter.trees ?? [];
		for (const tree of trees) {
			if (!into.includes(tree.path)) into.push(tree.path);
		}
		const letGo = olderInEachRepo(trees);
		const startedIn = (entry.doc.frontMatter.sessions ?? []).flatMap(
			(session) => (session.cwd === undefined ? [] : [session.cwd]),
		);
		for (const tree of trees) {
			const opened = startedIn.some(
				(cwd) => cwd === tree.path || cwd.startsWith(tree.path + sep),
			);
			if (letGo.has(tree.path) && !opened) older.push(tree.path);
			else kept.add(tree.path);
		}
		lists.set(entry.dir, new Set(trees.map((tree) => tree.path)));
	}
	for (const [dir, listed] of before ?? []) {
		if (lists.has(dir)) continue;
		for (const path of listed) kept.add(path);
	}
	if (mayTake === undefined) return lists;
	for (const path of older) {
		if (!kept.has(path) && !mayTake.includes(path)) mayTake.push(path);
	}
	for (let at = mayTake.length - 1; at >= 0; at--) {
		const path = mayTake[at];
		if (path !== undefined && kept.has(path)) mayTake.splice(at, 1);
	}
	return lists;
}

/**
 * The trees a quest lists here, in a known repository, before that
 * repository's last whose folder stands: the ones it lets idle rules
 * take.
 */
function olderInEachRepo(trees: readonly QuestTree[]): Set<string> {
	const here = treesHere(trees).filter(
		(tree) => tree.repoRoot !== undefined && existsSync(tree.path),
	);
	const newest = new Map<string, string>();
	for (const tree of here) newest.set(tree.repoRoot ?? "", tree.path);
	return new Set(
		here
			.filter((tree) => newest.get(tree.repoRoot ?? "") !== tree.path)
			.map((tree) => tree.path),
	);
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
		const swept = data as SweptTrees;
		forgetTrees(questsRoot, swept.paths, swept.branchesGone).catch(
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
	branchesGone?: readonly string[],
): Promise<void> {
	return forgetTaken(
		questsRoot,
		new Set(paths),
		branchesGone === undefined ? undefined : new Set(branchesGone),
	);
}

/**
 * Drop each tree in `taken` from every live quest that lists it, each
 * quest's write on its own, so one quest's locked or vanished folder
 * leaves the rest forgetting. A tree whose folder is back by the time
 * the walk ends was cut again at its path while the quest was signed,
 * so it stays listed. Its branch's alias stays while the branch does,
 * as an idle take leaves it, since a live quest's open change on that
 * branch still has to find it; one the sweep says it deleted goes with
 * its tree, as does every one when the sweep says nothing of branches.
 * A deleted branch's alias that an earlier take left goes too, from a
 * quest that lists no tree on it. Aliases name a branch alone, so a
 * branch of that name in another repository loses its alias with it,
 * unless the quest lists a tree on it.
 */
async function forgetTaken(
	questsRoot: string,
	taken: ReadonlySet<string>,
	branchesGone: ReadonlySet<string> | undefined,
): Promise<void> {
	const walks: DiscoveryResult[] = [];
	for (const store of storesOf(questsRoot)) {
		const walk = await signed(store);
		if (walk) walks.push(walk);
	}
	for (const entry of liveQuests(walks)) {
		forgetTakenFrom(entry, taken, branchesGone);
		// Only a quest whose alias names a deleted branch is locked to drop it.
		if (branchesGone === undefined || !aliasesAny(entry, branchesGone)) {
			continue;
		}
		try {
			const forgot = forgetBranchesFromQuest(entry.dir, branchesGone);
			if (!forgot.ok) throw new Error(forgot.reason);
		} catch (error) {
			sayForgetFailed(entry.doc.frontMatter.id, error);
		}
	}
}

/**
 * Whether the quest at `entry`, as its walk read it, has a `git-branch`
 * alias for any of `branches`.
 */
function aliasesAny(entry: QuestEntry, branches: ReadonlySet<string>): boolean {
	return entry.doc.frontMatter.aliases.some(
		(alias) => alias.type === "git-branch" && branches.has(alias.value),
	);
}

/**
 * Drop each tree in `taken` from the quest at `entry`, as
 * {@link forgetTaken} says.
 */
function forgetTakenFrom(
	entry: QuestEntry,
	taken: ReadonlySet<string>,
	branchesGone: ReadonlySet<string> | undefined,
): void {
	for (const tree of entry.doc.frontMatter.trees ?? []) {
		if (!taken.has(tree.path) || existsSync(tree.path)) continue;
		try {
			// A write refused says why as a throw does, and stops the second.
			const stands =
				branchesGone !== undefined &&
				tree.branch !== undefined &&
				!branchesGone.has(tree.branch);
			const removed = removeTreeFromQuest(entry.dir, tree.path, {
				keepBranch: stands,
			});
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
 * Undefined on a host that never walked it, since its only walk then
 * is a whole signing on the thread every conversation shares.
 */
async function signed(store: string): Promise<DiscoveryResult | undefined> {
	try {
		return await discoverQuestsAfresh(store);
	} catch (error) {
		// The disk didn't answer the signing; the last walk still stands,
		// and the journal says so, since its trees may be a while old.
		const why = error instanceof Error ? error.message : String(error);
		if (hosted() && !questsWalked(store)) {
			process.stderr.write(
				`[quest-workflow] tree claims in ${store} wait for the next sweep, never walked here: ${why}\n`,
			);
			return undefined;
		}
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
