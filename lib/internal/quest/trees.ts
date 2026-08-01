/**
 * Quest tree operations. Pure file-and-frontmatter
 * helpers; the extension wires them to a loaded quest.
 *
 * Trees live on a quest's frontmatter `trees:` array.
 * Aliases mirror each tree as `git-worktree:<path>` and
 * `git-branch:<branch>` so the cwd-walk auto-attach can
 * find the quest from inside the tree.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	QuestAlias,
	QuestFrontMatter,
	QuestTree,
} from "../../quest/types.js";
import { parseQuestFrontMatter } from "./frontmatter.js";
import { mutateQuestFrontMatter } from "./mutate.js";

/** Path to a quest's README. */
function questReadme(questDir: string): string {
	return join(questDir, "README.md");
}

/**
 * Apply a tree or alias change through the shared mutation core.
 *
 * This used to be a second copy of that core, living here because
 * trees were written before it existed. It locked, parsed, validated
 * by parse-back and wrote, all correctly, and stamped no `updated`
 * and journalled nothing, so adopting a tree left the quest reading
 * older than it was. Two implementations of one rule means one of
 * them is wrong, and it was this one.
 *
 * The transform reports what it did through the caller's own
 * closure, so nothing needs to travel back out of the lock.
 */
function changeQuestFrontMatter(
	questDir: string,
	transform: (fm: QuestFrontMatter) => QuestFrontMatter | undefined,
	op: string,
): { ok: true } | { ok: false; reason: string } {
	const outcome = mutateQuestFrontMatter(questDir, transform, { op });
	return outcome.ok ? { ok: true } : { ok: false, reason: outcome.guidance };
}

function ensureAlias(aliases: QuestAlias[], alias: QuestAlias): boolean {
	const exists = aliases.some(
		(a) => a.type === alias.type && a.value === alias.value,
	);
	if (exists) return false;
	aliases.push(alias);
	return true;
}

function removeAlias(aliases: QuestAlias[], alias: QuestAlias): boolean {
	const before = aliases.length;
	for (let i = aliases.length - 1; i >= 0; i--) {
		if (aliases[i].type === alias.type && aliases[i].value === alias.value) {
			aliases.splice(i, 1);
		}
	}
	return aliases.length !== before;
}

/** Append a tree to the quest's `trees:` list with its aliases. */
export function addTreeToQuest(
	questDir: string,
	tree: QuestTree,
): { ok: true; added: boolean } | { ok: false; reason: string } {
	let addedFlag = false;
	const outcome = changeQuestFrontMatter(
		questDir,
		(fm) => {
			const trees = fm.trees ?? [];
			// Already there: no change at all, rather than a rewrite that
			// stamps `updated` for a quest nothing happened to.
			if (trees.some((t) => t.path === tree.path)) return undefined;
			addedFlag = true;
			const nextTrees = [...trees, tree];
			const nextAliases = [...fm.aliases];
			ensureAlias(nextAliases, { type: "git-worktree", value: tree.path });
			if (tree.branch) {
				ensureAlias(nextAliases, { type: "git-branch", value: tree.branch });
			}
			return { ...fm, trees: nextTrees, aliases: nextAliases };
		},
		"tree-add",
	);
	if (!outcome.ok) return outcome;
	return { ok: true, added: addedFlag };
}

/** Remove a tree (by path) from the quest's `trees:` list. */
export function removeTreeFromQuest(
	questDir: string,
	path: string,
): { ok: true; removed: boolean } | { ok: false; reason: string } {
	let removedFlag = false;
	const outcome = changeQuestFrontMatter(
		questDir,
		(fm) => {
			const trees = fm.trees ?? [];
			const target = trees.find((t) => t.path === path);
			if (!target) return undefined;
			removedFlag = true;
			const nextTrees = trees.filter((t) => t.path !== path);
			const nextAliases = [...fm.aliases];
			removeAlias(nextAliases, { type: "git-worktree", value: path });
			if (target.branch) {
				removeAlias(nextAliases, { type: "git-branch", value: target.branch });
			}
			const next = { ...fm, aliases: nextAliases } as typeof fm;
			if (nextTrees.length > 0) next.trees = nextTrees;
			else delete (next as { trees?: QuestTree[] }).trees;
			return next;
		},
		"tree-remove",
	);
	if (!outcome.ok) return outcome;
	return { ok: true, removed: removedFlag };
}

/** Snapshot the quest's tree list. */
export function listTreesOnQuest(
	questDir: string,
): { ok: true; trees: QuestTree[] } | { ok: false; reason: string } {
	const path = questReadme(questDir);
	if (!existsSync(path))
		return { ok: false, reason: "Quest README not found." };
	// Read-only: the atomic-rename write contract guarantees
	// observers see either the old or the new file in full,
	// so this readFileSync cannot tear against a concurrent
	// writer.
	const text = readFileSync(path, "utf8");
	const parsed = parseQuestFrontMatter(text);
	if (!parsed) {
		return { ok: false, reason: "Quest README has no readable frontmatter." };
	}
	return { ok: true, trees: parsed.frontMatter.trees ?? [] };
}

/**
 * Append or replace a pendingPrune entry on the quest. Each
 * blocked tree is keyed by `path`: a second blocker for the
 * same path overwrites the first; blockers for distinct
 * paths accumulate. Pass `null` to clear every entry, or
 * pass `clearPath` to clear one entry by tree path.
 */
export function setPendingPrune(
	questDir: string,
	pending: { path: string; reason: string; detectedAt: string } | null,
	options?: { clearPath?: string },
): { ok: true } | { ok: false; reason: string } {
	const outcome = changeQuestFrontMatter(
		questDir,
		(fm) => {
			const next = { ...fm };
			const existing = next.pendingPrune ?? [];
			let merged = existing;
			if (pending === null && !options?.clearPath) {
				merged = [];
			} else if (options?.clearPath) {
				merged = existing.filter((e) => e.path !== options.clearPath);
			}
			if (pending) {
				merged = [...merged.filter((e) => e.path !== pending.path), pending];
			}
			if (merged.length > 0) next.pendingPrune = merged;
			else delete (next as { pendingPrune?: unknown }).pendingPrune;
			return next;
		},
		"tree-pending-prune",
	);
	if (!outcome.ok) return outcome;
	return { ok: true };
}
