/**
 * Which quest a working directory belongs to.
 *
 * The explicit load verb and the session-start restore both need this
 * answer, and both used to compute it themselves. The two copies were
 * kept in step by a comment asking the next reader to keep them in
 * step, and they had already drifted: one `isUnder` compared against a
 * hardcoded slash and the other against the platform separator.
 *
 * Taking the discovered index rather than reading the disk keeps this
 * a decision rather than an errand, so the preference rules can be
 * tested directly instead of through a temp directory and a session.
 */

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { QuestIndex } from "./discovery.js";
import { isSealedStatus } from "./status.js";

/**
 * Resolve symlinks so /var and /private/var, and bind mounts in a
 * container, compare equal. A path that does not exist is its own
 * answer: comparing the literal string is better than refusing.
 */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Whether `child` is `parent` or sits underneath it. */
function isUnder(child: string, parent: string): boolean {
	if (child === parent) return true;
	return child.startsWith(`${parent}${sep}`);
}

/**
 * The id of the quest that owns `cwd`, or undefined if none does.
 *
 * A quest's own directory is the strongest claim. Failing that, the
 * deepest scaffolded working tree covering the cwd wins, so a tree
 * nested inside another resolves to its immediate owner.
 *
 * A live quest beats a sealed one wherever both cover the cwd, so a
 * fresh session started inside a finished quest's tree does not
 * attach to the finished quest. Note this gates resolution only:
 * whether a sealed quest still owns a tree on disk is a different
 * question, and the answer there is that it does.
 *
 * Only `scaffolded` trees magnetize. An adopted or unmarked tree, and
 * a `git-worktree:` alias, is a reference to a checkout several quests
 * may name, so resolving through one would pick an arbitrary owner.
 */
export function questIdForCwd(
	index: QuestIndex,
	cwd: string,
): string | undefined {
	const target = canonical(cwd);

	let dirMatch: string | undefined;
	let dirMatchLive = false;
	for (const entry of index.quests.values()) {
		if (!isUnder(target, canonical(entry.dir))) continue;
		const live = !isSealedStatus(entry.doc.frontMatter.status);
		if (dirMatch === undefined || (live && !dirMatchLive)) {
			dirMatch = entry.doc.frontMatter.id;
			dirMatchLive = live;
		}
	}
	if (dirMatch !== undefined) return dirMatch;

	let bestId: string | undefined;
	let bestLen = -1;
	let bestLive = false;
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		const live = !isSealedStatus(fm.status);
		for (const tree of fm.trees ?? []) {
			if (tree.origin !== "scaffolded") continue;
			const real = canonical(tree.path);
			if (!isUnder(target, real)) continue;
			if (
				real.length > bestLen ||
				(real.length === bestLen && live && !bestLive)
			) {
				bestLen = real.length;
				bestId = fm.id;
				bestLive = live;
			}
		}
	}
	return bestId;
}
