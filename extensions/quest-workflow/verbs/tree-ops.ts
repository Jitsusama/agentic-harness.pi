/**
 * Tree-operation verbs: tree-add, tree-list, tree-release,
 * tree-expand. Each delegates to the resolved tree
 * provider (built-in git-worktree, or a downstream
 * provider like dev-tree for the World monorepo).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getTreeProvider,
	resolveTreeProvider,
} from "../../../lib/core/tree/index.ts";
import { stateDir } from "../../../lib/internal/paths.ts";
import { discoverQuests } from "../../../lib/internal/quest/discovery.ts";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/frontmatter.ts";
import {
	canonicalPath,
	gitTreeRootOf,
	hasNoCommits,
	isMainWorkingTree,
	isWithin,
} from "../../../lib/internal/quest/git-signals.ts";
import { isSealedStatus } from "../../../lib/internal/quest/status.ts";
import {
	treePlace,
	treesHere,
} from "../../../lib/internal/quest/tree-place.ts";
import {
	addTreeToQuest,
	listTreesOnQuest,
	removeTreeFromQuest,
	setPendingPrune,
} from "../../../lib/internal/quest/trees.ts";
import { repoRulesNote } from "../../../lib/internal/session/repo-rules.ts";
import type { QuestSession, QuestTree } from "../../../lib/quest/index.ts";
import { count, noun } from "../../../lib/ui/count.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { inventoryWorktrees, logHarnessEntry } from "../lifecycle.ts";
import type { QuestState } from "../state.ts";
import {
	currentSessionId,
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/**
 * A tree-add or tree-adopt answer, with the tree's repo rules said
 * after it when pi loaded none from that repo at the session's start,
 * once a repo a session. A refusal, or a tree already tracked, is
 * answered as it was.
 */
export function withRepoRules(
	result: QuestResult,
	ctx: ExtensionContext,
): QuestResult {
	if (!result.ok) return result;
	const tree = result.details?.tree;
	const path =
		typeof tree === "object" && tree !== null && "path" in tree
			? tree.path
			: undefined;
	if (typeof path !== "string") return result;
	const note = repoRulesNote({
		tree: path,
		cwd: ctx.cwd ?? process.cwd(),
		session: currentSessionId(ctx, undefined) ?? "",
	});
	return note ? { ...result, message: `${result.message}\n\n${note}` } : result;
}

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
	signal?: AbortSignal,
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
		const root = gitTreeRootOf(repoRoot);
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
			...(signal ? { signal } : {}),
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
		logHarnessEntry(
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
	const adopted = adoptTreeAt(
		state,
		defaultRepoRoot(state, params),
		params.force === true,
	);
	if (!adopted.ok) return refuse(adopted.reason);
	const { tree } = adopted;
	if (!adopted.added) {
		return ok(`Tree at ${tree.path} is already tracked on this quest.`, {
			tree,
		});
	}
	return ok(`Adopted tree at ${tree.path}; it will not be auto-pruned.`, {
		tree,
	});
}

/** A tree a quest adopted, or why it would not. */
type Adoption =
	| {
			ok: true;
			tree: QuestTree & { origin: "adopted" };
			/** False when the quest already held it. */
			added: boolean;
	  }
	| { ok: false; reason: string };

/**
 * Record the git tree holding `start` on the loaded quest as adopted,
 * journaling it, under the guards a shared checkout needs unless
 * `force`. `tree-adopt` is this as a verb, and `tree-expand` does it
 * for a tree it is pointed at that the quest has no record of.
 */
function adoptTreeAt(
	state: QuestState,
	start: string,
	force: boolean,
): Adoption {
	if (!state.questDir) return { ok: false, reason: "Load a quest first." };
	const root = gitTreeRootOf(start);
	if (!root) {
		return {
			ok: false,
			reason: `${start} is not inside a git working tree. Pass cwd pointing at a path inside the tree you want to adopt; you do not need to change your session's directory.`,
		};
	}
	// Guard a shared checkout before binding: a path another quest
	// already tracks, or a repository's main working tree, is the shape
	// that lets many quests bind to one checkout and magnetize a
	// session ambiguously. Warn and require force rather than adopt
	// silently; tree-adopt stays first-class, the guard just makes a
	// shared bind a deliberate act. A repository with no commits yet is
	// one just made, by this quest, so nobody shares it and it is adopted
	// as any tree is: one quest got Joel woken to run `git init`.
	if (!force) {
		const otherQuest = pathAdoptedByAnotherQuest(state, root);
		if (otherQuest) {
			return {
				ok: false,
				reason: `${root} is already tracked by ${otherQuest}. Adopting one checkout on several quests is what makes a fresh session resolve to an arbitrary quest. Pass force:true to adopt it here as well, or scaffold a private worktree with tree-add.`,
			};
		}
		if (isMainWorkingTree(root) && !hasNoCommits(root)) {
			return {
				ok: false,
				reason: `${root} is a repository's main working tree, not a scaffolded worktree. Adopting a shared main checkout binds this quest to it. Pass force:true to confirm, or scaffold a private worktree with tree-add.`,
			};
		}
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
	if (!result.ok) return { ok: false, reason: result.reason };
	if (!result.added) return { ok: true, tree, added: false };
	// The Journey is prose held to the column rule, and an absolute
	// path is the one thing in it that cannot be wrapped. A tilde is a
	// courtesy for a reader, and the Journey has no other kind of
	// audience: nothing reads a path back out of it.
	logHarnessEntry(state, `Adopted tree at ${displayPath(root)}.`);
	return { ok: true, tree, added: true };
}

/**
 * The id of another quest that already tracks a tree at this path, or
 * undefined when only the loaded quest (or no quest) does. Paths are
 * canonicalized so a /var versus /private/var spelling still matches.
 */
function pathAdoptedByAnotherQuest(
	state: QuestState,
	root: string,
): string | undefined {
	const target = canonicalPath(root);
	const { index } = discoverQuests(state.questsRoot);
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		if (fm.id === state.questId) continue;
		// Only a live quest is a competing claim. The guard exists because
		// two quests holding one checkout make a fresh session resolve to
		// an arbitrary one, and a sealed quest cannot magnetize a session:
		// the cwd resolver prefers a live quest over a sealed one wherever
		// both match. Counting a finished quest's claim strands the
		// checkout instead, because the only quest that could release it
		// is the one that is over.
		if (isSealedStatus(fm.status)) continue;
		// Another machine's tree that reads as this path is no claim on
		// the checkout here.
		for (const tree of treesHere(fm.trees ?? [])) {
			if (canonicalPath(tree.path) === target) return fm.id;
		}
	}
	return undefined;
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
		return ok(
			`${count(inventory.length, "tree")} across all quests${missingNote}.`,
			{
				scope: "global",
				trees: inventory,
			},
		);
	}
	const result = listTreesOnQuest(state.questDir);
	if (!result.ok) return refuse(result.reason);
	const trees = result.trees.map((tree) => ({
		...tree,
		place: treePlace(tree),
	}));
	const elsewhere = trees.filter((t) => t.place === "elsewhere").length;
	const unplaced = trees.filter((t) => t.place === "unplaced").length;
	const notes = [
		...(elsewhere > 0 ? [`${elsewhere} on another machine`] : []),
		...(unplaced > 0 ? [`${unplaced} not on this machine`] : []),
	];
	const noted = notes.length > 0 ? ` (${notes.join(", ")})` : "";
	return ok(`${count(trees.length, "tree")} on the loaded quest${noted}.`, {
		scope: "quest",
		trees,
	});
}

/**
 * The quest's trees with this machine's first, so a path that two
 * machines' trees both read as resolves to the one here.
 */
function hereFirst(trees: QuestTree[]): QuestTree[] {
	const here = treesHere(trees);
	return [...here, ...trees.filter((tree) => !here.includes(tree))];
}

/**
 * Why a verb that changes a tree may not act on this one, or undefined
 * when it is this machine's. An unplaced tree may be another machine's,
 * seen through a shared quest, or gone; only `force` lets it go.
 */
function notOursToChange(
	tree: QuestTree,
	verb: string,
	force: boolean,
): string | undefined {
	const place = treePlace(tree);
	if (place === "elsewhere") {
		return `Tree at ${displayPath(tree.path)} is on ${tree.host}, not this machine; only ${tree.host} can ${verb} it.`;
	}
	if (place === "unplaced" && !force) {
		return `Tree at ${displayPath(tree.path)} names no machine and isn't on this one: it may be another machine's, through a shared quest, or gone. Pass force:true once the person confirms it's gone, and only its record is dropped.`;
	}
	return undefined;
}

/**
 * The tree a verb was pointed at: the one holding `named`, the deepest
 * when trees nest, or the only tree when nothing was named. Anything
 * else is refused with the trees listed, since the verbs that ask are
 * the ones that change or delete a tree, and a guess there acts on a
 * tree nobody chose.
 */
function namedTree(
	trees: QuestTree[],
	named: string | undefined,
	verb: string,
): { ok: true; tree: QuestTree } | { ok: false; reason: string } {
	const listed = trees.map((t) => `  ${displayPath(t.path)}`).join("\n");
	const wanted = named?.trim();
	if (!wanted) {
		if (trees.length === 1) return { ok: true, tree: trees[0] };
		return {
			ok: false,
			reason: `The loaded quest has ${count(trees.length, "tree")}; name the one for ${verb} with \`cwd\`, a path inside it:\n${listed}`,
		};
	}
	const path = resolve(expandHome(wanted));
	const holding = trees
		.filter((t) => isWithin(path, t.path))
		.sort(
			(a, b) => canonicalPath(b.path).length - canonicalPath(a.path).length,
		);
	if (holding.length > 0) return { ok: true, tree: holding[0] };
	return {
		ok: false,
		reason: `No tree on the loaded quest holds ${displayPath(path)}. Its ${noun(trees.length, "tree")}:\n${listed}`,
	};
}

/**
 * The tree an expand acts on: the recorded one holding `named`, as the
 * other verbs find theirs, or else the git tree holding it, adopted onto
 * the quest first. Sessions cut trees the quest never recorded, and an
 * expand of one was refused only to be adopted and asked again: 32 of
 * 46 such refusals from 2026-11-04 to 2026-11-09. Adding a zone changes
 * nothing already checked out, so adopting what was named is no guess;
 * a tree another quest holds, or a repository's main checkout, is still
 * refused, as `tree-adopt` refuses it.
 */
function treeToExpand(
	state: QuestState,
	trees: QuestTree[],
	named: string | undefined,
):
	| { ok: true; tree: QuestTree; adopted: boolean }
	| { ok: false; reason: string } {
	const recorded =
		trees.length > 0
			? namedTree(hereFirst(trees), named, "tree-expand")
			: undefined;
	if (recorded?.ok) return { ...recorded, adopted: false };
	if (!named) {
		return {
			ok: false,
			reason: recorded?.reason ?? "Name the tree to expand.",
		};
	}
	const path = resolve(expandHome(named));
	const adoption = adoptTreeAt(state, path, false);
	if (!adoption.ok) {
		return {
			ok: false,
			reason: recorded
				? `${recorded.reason}\nIt was not adopted either: ${adoption.reason}`
				: adoption.reason,
		};
	}
	const relisted = listTreesOnQuest(state.questDir ?? "");
	if (!relisted.ok) return { ok: false, reason: relisted.reason };
	const found = namedTree(relisted.trees, path, "tree-expand");
	return found.ok ? { ...found, adopted: adoption.added } : found;
}

/** A path with a leading `~` read as the home directory, as a shell would. */
function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export async function treeRelease(
	state: QuestState,
	params: QuestToolParams,
	signal?: AbortSignal,
): Promise<QuestResult> {
	if (!state.questDir || !state.questId) {
		return refuse("Load a quest first.");
	}
	const listing = listTreesOnQuest(state.questDir);
	if (!listing.ok) return refuse(listing.reason);
	if (listing.trees.length === 0) {
		return refuse("No trees on the loaded quest to release.");
	}
	// `ref` is accepted for the prune alone, because it is what this
	// verb matched on before `cwd` named the tree.
	const chosen = namedTree(
		hereFirst(listing.trees),
		params.cwd ?? params.target ?? params.ref,
		"tree-release",
	);
	if (!chosen.ok) return refuse(chosen.reason);
	const target = chosen.tree;
	const refused = notOursToChange(target, "release", params.force === true);
	if (refused) return refuse(refused);
	// A tree whose folder is already gone, given back some other way,
	// leaves only its record, and dropping that deletes nothing, so no
	// consent is asked for.
	const gone = !existsSync(target.path);
	// `force` is a typed boolean parameter. The agent flips
	// it only after confirming destructive intent with the
	// user. We deliberately do NOT key off a `note` string
	// because notes are free-form prose the agent generates,
	// not consent. `force: true` is the consent signal.
	const force = params.force === true;
	// An adopted tree was made by someone else, so releasing it lets go
	// of the quest's record and leaves the folder to whoever made it.
	// Nothing is deleted, so neither consent nor a detach is asked for.
	if (target.origin === "adopted" && !force && !gone) {
		return letGoOf(state, target.path);
	}
	// An unmarked (legacy, hand-registered) tree may be a shared
	// checkout or one the tool cut before it said so; deleting it needs
	// explicit, confirmed consent rather than a guess.
	if (target.origin !== "scaffolded" && !force && !gone) {
		const kind = target.origin ?? "unmarked";
		return refuse(
			`Tree at ${displayPath(target.path)} is ${kind}, not scaffolded by the tool. Releasing it would delete a shared checkout; pass force:true after confirming with the person.`,
		);
	}
	const sessions = readSessionsFromQuest(state);
	const attached = sessions.filter(
		(s) => s.cwd && isWithin(s.cwd, target.path),
	);
	if (attached.length > 0 && !force && !gone) {
		const names = attached.map((s) => s.name ?? s.id).join(", ");
		return refuse(
			`Tree at ${displayPath(target.path)} has an attached ${noun(attached.length, "session")} (${names}). Detach them with \`session-detach\` before releasing it, or pass force:true after confirming with the person.`,
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
		if (gone) return forgetTree(state, target.path);
		return refuse(
			`No tree provider applies to ${target.repoRoot ?? target.path}.`,
		);
	}
	try {
		await provider.release({
			path: target.path,
			force,
			...(signal ? { signal } : {}),
		});
	} catch (error) {
		// The provider found nothing to remove; git forgets its own note
		// of the worktree at its next `git worktree prune`.
		if (gone) return forgetTree(state, target.path);
		const message = error instanceof Error ? error.message : String(error);
		const detectedAt = new Date().toISOString();
		setPendingPrune(state.questDir, {
			path: target.path,
			reason: message,
			detectedAt,
		});
		return refuse(
			`Tree release blocked: ${message} Resolve the conflict and retry, or pass force:true after confirming with the person.`,
		);
	}
	const removal = removeTreeFromQuest(state.questDir, target.path);
	if (!removal.ok) return refuse(removal.reason);
	setPendingPrune(state.questDir, null, { clearPath: target.path });
	logHarnessEntry(state, `Released tree at ${target.path}.`);
	// The tilde form for the person reading; the absolute path stays in details,
	// which is what a caller acts on.
	return ok(`Tree at ${displayPath(target.path)} released.`, {
		path: target.path,
	});
}

/**
 * Drop the record of a tree the quest adopted, leaving its folder,
 * since the quest never made it. A tree the work tool cut is still held
 * there, and only `work release` gives it back, so the answer says so.
 */
function letGoOf(state: QuestState, path: string): QuestResult {
	if (!state.questDir) return refuse("Load a quest first.");
	const removal = removeTreeFromQuest(state.questDir, path);
	if (!removal.ok) return refuse(removal.reason);
	setPendingPrune(state.questDir, null, { clearPath: path });
	logHarnessEntry(
		state,
		`Let go of adopted tree at ${path}; its folder stays.`,
	);
	const key = workTreeKey(path);
	const held = key
		? ` The work tool still holds it: \`work release\` with tree ${key} gives it back.`
		: "";
	return ok(
		`Tree at ${displayPath(path)} was adopted, not made by the quest, so only its record was dropped and the folder stays.${held}`,
		{ path },
	);
}

/**
 * The key of the work tool's tree a path sits in, which is its folder's
 * name under the work tool's trees folder; nothing for any other path.
 */
function workTreeKey(path: string): string | undefined {
	const within = relative(
		canonicalPath(join(stateDir("work"), "trees")),
		canonicalPath(resolve(path)),
	);
	if (!within || within.startsWith("..") || isAbsolute(within)) {
		return undefined;
	}
	return within.split(sep)[0];
}

/** Drop the record of a tree whose folder is already gone. */
function forgetTree(state: QuestState, path: string): QuestResult {
	if (!state.questDir) return refuse("Load a quest first.");
	const removal = removeTreeFromQuest(state.questDir, path);
	if (!removal.ok) return refuse(removal.reason);
	setPendingPrune(state.questDir, null, { clearPath: path });
	logHarnessEntry(state, `Forgot tree at ${path}, already gone.`);
	return ok(
		`Tree at ${displayPath(path)} was already gone, so only its record was dropped.`,
		{ path },
	);
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
	const named = (params.cwd ?? params.target)?.trim();
	if (listing.trees.length === 0 && !named) {
		return refuse(
			"No trees on the loaded quest. Name the tree to expand with `cwd`, or run tree-add first.",
		);
	}
	const chosen = treeToExpand(state, listing.trees, named);
	if (!chosen.ok) return refuse(chosen.reason);
	const { tree: target, adopted } = chosen;
	const refused = notOursToChange(target, "expand", false);
	if (refused) return refuse(refused);
	// The provider that made the tree, as a prune finds it, so an
	// expand cannot reach a different provider that happens to win
	// resolution today.
	const provider =
		(target.providerId ? getTreeProvider(target.providerId) : undefined) ??
		resolveTreeProvider(target.repoRoot ?? target.path);
	if (!provider) {
		return refuse(`No tree provider applies to ${displayPath(target.path)}.`);
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
		await expander.call(provider, { path: target.path, zone });
		logHarnessEntry(state, `Expanded ${target.path} with zone ${zone}.`);
		const first = adopted
			? `Adopted tree at ${displayPath(target.path)} onto this quest first, since it had no record of it; it will not be auto-pruned. `
			: "";
		return ok(`${first}Zone ${zone} added to ${displayPath(target.path)}.`, {
			zone,
			...(adopted ? { adopted: target.path } : {}),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return refuse(`Tree expand failed: ${message}`);
	}
}
