/**
 * Tree-operation verbs: tree-add, tree-list, tree-prune,
 * tree-expand. Each delegates to the resolved tree
 * provider (built-in git-worktree, or a downstream
 * provider like dev-tree for the World monorepo).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/frontmatter.js";
import {
	gitTreeRootOf,
	isWithin,
} from "../../../lib/internal/quest/git-signals.js";
import {
	addTreeToQuest,
	listTreesOnQuest,
	removeTreeFromQuest,
	setPendingPrune,
} from "../../../lib/internal/quest/trees.js";
import type { QuestSession } from "../../../lib/quest/index.js";
import {
	getTreeProvider,
	resolveTreeProvider,
} from "../../../lib/tree/index.js";
import { appendJourneyEntry, inventoryWorktrees } from "../lifecycle.js";
import type { QuestState } from "../state.js";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.js";

function defaultRepoRoot(_state: QuestState, params: QuestToolParams): string {
	if (params.cwd) return params.cwd;
	return process.cwd();
}

function readSessionsFromQuest(state: QuestState): QuestSession[] {
	if (!state.questDir) return [];
	try {
		const readme = join(state.questDir, "README.md");
		const text = readFileSync(readme, "utf8");
		const parsed = parseQuestFrontMatter(text);
		return parsed?.frontMatter.sessions ?? [];
	} catch {
		// Quest README missing or unreadable; treat as no
		// sessions so we don't accidentally block pruning.
		return [];
	}
}

export async function treeAdd(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	if (!state.questDir || !state.questId) {
		return refuse("Load a quest first.");
	}
	let repoRoot = defaultRepoRoot(state, params);
	let provider = resolveTreeProvider(repoRoot);
	if (!provider) {
		// The cwd may be a subdirectory of a repository, where the
		// built-in git-worktree provider (which looks for .git at the
		// root) does not apply. Resolve to the enclosing git root and
		// retry, so tree-add from a deep working directory no longer
		// hard-fails on the wrong cwd. Downstream providers that match
		// the raw root are untouched; this only rescues the no-match case.
		const root = gitTreeRootOf(join(repoRoot, ".quest-tree-probe"));
		if (root) {
			repoRoot = root;
			provider = resolveTreeProvider(repoRoot);
		}
	}
	if (!provider) {
		return refuse(
			`No tree provider applies to ${repoRoot}, and it is not inside a git repository. Pass cwd pointing at your repo (you do not need to change your session's directory), or register a provider (the harness ships git-worktree as a default).`,
		);
	}
	const name =
		params.name?.trim() || params.title?.trim() || state.questId.toLowerCase();
	try {
		const handle = await provider.create({
			name,
			repoRoot,
			baseBranch: params.ref,
		});
		const tree = {
			path: handle.path,
			branch: handle.branch,
			repoRoot: handle.repoRoot,
			providerId: handle.providerId,
			origin: "scaffolded" as const,
		};
		const result = addTreeToQuest(state.questDir, tree);
		if (!result.ok) return refuse(result.reason);
		appendJourneyEntry(
			state,
			`Added ${handle.providerId} tree at ${handle.path}.`,
		);
		return ok(`Tree ready at ${handle.path}.`, { tree });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return refuse(`Tree create failed: ${message}`);
	}
}

/**
 * Adopt the existing git tree at the cwd: register it on the quest
 * without creating anything, marked `adopted` so conclude and retire
 * never auto-prune it. This is the deliberate, explicit alternative
 * to scaffolding a fresh worktree; the act of running it is the
 * consent, so there is no inference and no silent binding.
 */
export function treeAdopt(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	if (!state.questDir || !state.questId) {
		return refuse("Load a quest first.");
	}
	const start = defaultRepoRoot(state, params);
	const root = gitTreeRootOf(join(start, ".quest-tree-probe"));
	if (!root) {
		return refuse(
			`${start} is not inside a git working tree. Pass cwd pointing at a path inside the tree you want to adopt; you do not need to change your session's directory.`,
		);
	}
	const provider = resolveTreeProvider(root);
	// repoRoot is recorded as the adopted tree's own root. For a
	// linked worktree that is the worktree dir rather than the main
	// repo, unlike a scaffolded tree, but it is sufficient here: an
	// adopted tree is never auto-pruned, and the provider resolves
	// from the path either way, so the value is only a reference.
	const tree = {
		path: root,
		repoRoot: root,
		providerId: provider?.id ?? "git-worktree",
		origin: "adopted" as const,
	};
	const result = addTreeToQuest(state.questDir, tree);
	if (!result.ok) return refuse(result.reason);
	if (!result.added) {
		return ok(`Tree at ${root} is already tracked on this quest.`, { tree });
	}
	appendJourneyEntry(state, `Adopted tree at ${root}.`);
	return ok(`Adopted tree at ${root}; it will not be auto-pruned.`, { tree });
}

export function treeList(state: QuestState): QuestResult {
	if (!state.questDir) {
		// No quest loaded: return the cross-quest inventory so
		// the harness-created trees can be seen in one place.
		const inventory = inventoryWorktrees(state);
		// scope tells a consumer which shape `trees` carries: the
		// global inventory entries are attributed (questId/questTitle),
		// the per-quest records are not.
		const missing = inventory.filter((t) => !t.exists).length;
		const missingNote = missing > 0 ? ` (${missing} missing on disk)` : "";
		return ok(`${inventory.length} tree(s) across all quests${missingNote}.`, {
			scope: "global",
			trees: inventory,
		});
	}
	const result = listTreesOnQuest(state.questDir);
	if (!result.ok) return refuse(result.reason);
	return ok(`${result.trees.length} tree(s) on the loaded quest.`, {
		scope: "quest",
		trees: result.trees,
	});
}

export async function treePrune(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	if (!state.questDir || !state.questId) {
		return refuse("Load a quest first.");
	}
	const listing = listTreesOnQuest(state.questDir);
	if (!listing.ok) return refuse(listing.reason);
	if (listing.trees.length === 0) {
		return refuse("No trees on the loaded quest to prune.");
	}
	const target =
		listing.trees.find(
			(t) => t.path === params.target || t.path === params.ref,
		) ?? listing.trees[0];
	// `force` is a typed boolean parameter. The agent flips
	// it only after confirming destructive intent with the
	// user. We deliberately do NOT key off a `note` string
	// because notes are free-form prose the agent generates,
	// not consent. `force: true` is the consent signal.
	const force = params.force === true;
	// Only a tool-scaffolded tree may be pruned without force. An
	// adopted or unmarked (legacy, hand-registered) tree is a shared
	// checkout the tool did not create, so deleting it needs explicit,
	// confirmed consent rather than a mistyped target.
	if (target.origin !== "scaffolded" && !force) {
		const kind = target.origin ?? "unmarked";
		return refuse(
			`Tree at ${target.path} is ${kind}, not scaffolded by the tool. Pruning it would delete a shared checkout; pass force:true after confirming with the user.`,
		);
	}
	const sessions = readSessionsFromQuest(state);
	const attached = sessions.filter(
		(s) => s.cwd && isWithin(s.cwd, target.path),
	);
	if (attached.length > 0 && !force) {
		const names = attached.map((s) => s.name ?? s.id).join(", ");
		return refuse(
			`Tree at ${target.path} has attached session(s) (${names}). Detach them with \`session-detach\` before pruning, or pass force:true after confirming with the user.`,
		);
	}
	// Prefer the provider that created the tree, recorded as its
	// providerId, so a prune reaches the same provider even if the
	// registry's resolution order changed since the tree was made.
	// Fall back to repo-root resolution for legacy trees with no id.
	const provider =
		(target.providerId ? getTreeProvider(target.providerId) : undefined) ??
		resolveTreeProvider(target.repoRoot ?? target.path) ??
		resolveTreeProvider(process.cwd());
	if (!provider) {
		return refuse(
			`No tree provider applies to ${target.repoRoot ?? target.path}.`,
		);
	}
	try {
		await provider.prune({ path: target.path, force });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const detectedAt = new Date().toISOString();
		setPendingPrune(state.questDir, {
			path: target.path,
			reason: message,
			detectedAt,
		});
		return refuse(
			`Tree prune blocked: ${message} Resolve the conflict and retry, or pass force:true after confirming with the user.`,
		);
	}
	const removal = removeTreeFromQuest(state.questDir, target.path);
	if (!removal.ok) return refuse(removal.reason);
	setPendingPrune(state.questDir, null, { clearPath: target.path });
	appendJourneyEntry(state, `Pruned tree at ${target.path}.`);
	return ok(`Tree at ${target.path} pruned.`, { path: target.path });
}

export async function treeExpand(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	if (!state.questDir) return refuse("Load a quest first.");
	const zone = params.ref?.trim();
	if (!zone) {
		return refuse("Pass the zone to add in `ref` (e.g. system/gitstream).");
	}
	const listing = listTreesOnQuest(state.questDir);
	if (!listing.ok) return refuse(listing.reason);
	if (listing.trees.length === 0) {
		return refuse("No trees on the loaded quest. Run tree-add first.");
	}
	const target = listing.trees[0];
	const provider = resolveTreeProvider(target.repoRoot ?? target.path);
	if (!provider) {
		return refuse("No tree provider applies to the loaded quest's tree.");
	}
	const expander = (
		provider as unknown as {
			expand?: (input: { path: string; zone: string }) => Promise<void>;
		}
	).expand;
	if (typeof expander !== "function") {
		return refuse(
			`Provider ${provider.id} does not support expand. (zone-aware providers, like dev-tree in joel.gerber.pi, implement this.)`,
		);
	}
	try {
		await expander({ path: target.path, zone });
		appendJourneyEntry(state, `Expanded ${target.path} with zone ${zone}.`);
		return ok(`Zone ${zone} added to ${target.path}.`, { zone });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return refuse(`Tree expand failed: ${message}`);
	}
}
