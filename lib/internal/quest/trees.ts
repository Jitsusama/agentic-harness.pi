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
import type { QuestAlias, QuestTree } from "../../quest/types.js";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "./frontmatter.js";
import { atomicWriteFile, withQuestLock } from "./io.js";

/** Path to a quest's README. */
function questReadme(questDir: string): string {
	return join(questDir, "README.md");
}

/**
 * Read a quest README, run `mutate` on the parsed
 * frontmatter, write the result back. Returns the mutated
 * frontmatter on success or undefined on parse failure.
 */
function withQuestFrontMatter<T>(
	questDir: string,
	mutate: (
		fm: ReturnType<typeof parseQuestFrontMatter>,
	) => { fm: T; ok: true } | { fm?: never; ok: false; reason: string },
): { ok: true; result: T } | { ok: false; reason: string } {
	const path = questReadme(questDir);
	if (!existsSync(path))
		return { ok: false, reason: "Quest README not found." };
	return withQuestLock(questDir, () => {
		const text = readFileSync(path, "utf8");
		const parsed = parseQuestFrontMatter(text);
		if (!parsed) {
			return {
				ok: false as const,
				reason: "Quest README has no readable frontmatter.",
			};
		}
		const outcome = mutate(parsed);
		if (!outcome.ok) return outcome;
		const next = outcome.fm as unknown as Parameters<
			typeof serializeQuestFrontMatter
		>[0];
		atomicWriteFile(path, `${serializeQuestFrontMatter(next)}\n${parsed.body}`);
		return { ok: true as const, result: outcome.fm };
	});
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
	const outcome = withQuestFrontMatter(questDir, (parsed) => {
		if (!parsed) return { ok: false, reason: "Quest README missing." };
		const fm = parsed.frontMatter;
		const trees = fm.trees ?? [];
		const already = trees.some((t) => t.path === tree.path);
		if (already) {
			return { fm: { ...fm, trees }, ok: true };
		}
		addedFlag = true;
		const nextTrees = [...trees, tree];
		const nextAliases = [...fm.aliases];
		ensureAlias(nextAliases, { type: "git-worktree", value: tree.path });
		if (tree.branch) {
			ensureAlias(nextAliases, { type: "git-branch", value: tree.branch });
		}
		return {
			fm: { ...fm, trees: nextTrees, aliases: nextAliases },
			ok: true,
		};
	});
	if (!outcome.ok) return outcome;
	return { ok: true, added: addedFlag };
}

/** Remove a tree (by path) from the quest's `trees:` list. */
export function removeTreeFromQuest(
	questDir: string,
	path: string,
): { ok: true; removed: boolean } | { ok: false; reason: string } {
	let removedFlag = false;
	const outcome = withQuestFrontMatter(questDir, (parsed) => {
		if (!parsed) return { ok: false, reason: "Quest README missing." };
		const fm = parsed.frontMatter;
		const trees = fm.trees ?? [];
		const target = trees.find((t) => t.path === path);
		if (!target) {
			return { fm, ok: true };
		}
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
		return { fm: next, ok: true };
	});
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
	const outcome = withQuestFrontMatter(questDir, (parsed) => {
		if (!parsed) return { ok: false, reason: "Quest README missing." };
		const next = { ...parsed.frontMatter };
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
		return { fm: next, ok: true };
	});
	if (!outcome.ok) return outcome;
	return { ok: true };
}
