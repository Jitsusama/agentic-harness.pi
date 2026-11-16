/**
 * Scope: the groups a peer is in because of the work it does, rather
 * than because it joined them.
 *
 * Joel wanted the mesh "modeled after communities of growing levels of
 * size", and the swarm quest found that an agent in a single network
 * is a smell. So a peer is born into a group for each level of what it
 * works on, from the narrowest out:
 *
 * - its home, `@ADDRESS` (see group.ts);
 * - its quest, `#quest/<root>/.../<own>`, named down the quest's parent
 *   chain, so a message to `#quest/5gv2ah` reaches every peer on that
 *   quest or a quest under it, as nested groups do;
 * - each orchestration it is in, `#orchestration/<address>`: the one
 *   its quest answers to, and its own when its quest orchestrates, so
 *   an orchestrator nested under another hears both and the sessions
 *   under it hear only its own (see internal/quest/orchestration.ts);
 * - each repository its work is in, `#repo/<name>`;
 * - the machine, `#all`.
 *
 * Scopes follow the work: loading another quest or adding a tree moves
 * a peer between them, and it cannot leave one while the work is there.
 * What it hears from them is still its own to weigh, at whatever
 * attention it gives.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isRecord } from "../internal/record.ts";
import { treesHeldBy } from "../internal/work-records.ts";
import { questAddress } from "./address.ts";

/** What a peer's scopes are worked out from. */
export interface Work {
	/** The quest it has loaded, then each parent up to the root. */
	readonly questChain: readonly string[];
	/** The names of the repositories its work is in. */
	readonly repositories: readonly string[];
	/**
	 * The orchestrating quests it is in: the one above its quest, and its
	 * quest when that orchestrates. Missing when it is in none.
	 */
	readonly orchestrations?: readonly string[];
}

/** The deepest quest group that is written out; deeper is very rare. */
const MOST_QUEST_LEVELS = 6;

/** The groups this work puts a peer in, canonical and sorted. */
export function scopesOf(work: Work): string[] {
	const quest = [...work.questChain]
		.reverse()
		.slice(-MOST_QUEST_LEVELS)
		.map((id) => part(questAddress(id)))
		.filter(Boolean);
	const repositories = work.repositories
		.map(part)
		.filter(Boolean)
		.map((name) => `#repo/${name}`);
	const orchestrations = (work.orchestrations ?? [])
		.map((id) => part(questAddress(id)))
		.filter(Boolean)
		.map(orchestrationGroup);
	return [
		...new Set([
			...(quest.length > 0 ? [`#quest/${quest.join("/")}`] : []),
			...orchestrations,
			...repositories,
		]),
	].sort();
}

/**
 * The group of the orchestration an orchestrator's address heads:
 * `#orchestration/wcjqsg`. Named by address rather than short name,
 * since an address stays put while a short name changes and holds
 * spaces.
 */
export function orchestrationGroup(address: string): string {
	return `#orchestration/${part(address)}`;
}

/** Whether a group is an orchestration's. */
export function isOrchestrationGroup(group: string): boolean {
	return group.startsWith("#orchestration/");
}

/**
 * A name as one part of a group's path: lower-case letters, digits and
 * dashes, so `agentic-harness.pi` is `agentic-harness-pi`.
 */
export function part(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Checkouts found for a folder, by the folder; they rarely change. */
const checkouts = new Map<string, string | undefined>();

/**
 * The checkout a folder is in, found by looking up for a `.git`, and
 * never the home directory's, which says nothing about the work.
 */
export function checkoutOf(cwd: string): string | undefined {
	if (checkouts.has(cwd)) return checkouts.get(cwd);
	let found: string | undefined;
	for (let at = cwd; at !== homedir(); at = dirname(at)) {
		if (existsSync(join(at, ".git"))) {
			found = at;
			break;
		}
		if (dirname(at) === at) break;
	}
	checkouts.set(cwd, found);
	return found;
}

/** Repository names already read, by checkout; they never change. */
const repositories = new Map<string, string>();

/**
 * The name of the repository checked out here, as people write it
 * (agentic-harness.pi), rather than the folder it sits in, which for a
 * worktree is a name only the tree broker uses. Read from the origin
 * remote in git's own config, without running git, since presence is
 * worked out often. With no such remote, the main checkout's folder,
 * so every worktree of a local repository shares one group rather than
 * each making its own (71 `#repo/worktree-local-acceluary-*` on 15
 * November).
 */
export function repositoryName(checkout: string): string {
	const known = repositories.get(checkout);
	if (known !== undefined) return known;
	const name = originName(checkout) ?? mainCheckoutName(checkout);
	repositories.set(checkout, name);
	return name;
}

function originName(checkout: string): string | undefined {
	const name = originUrl(checkout)
		?.replace(/\/+$/, "")
		.split(/[/:]/)
		.pop()
		?.replace(/\.git$/, "");
	return name && name.length > 0 ? name : undefined;
}

/**
 * The key of the repository checked out here, as the tree broker and
 * mycelium write one (`github:Jitsusama/mycelium`): its origin's host,
 * GitHub's as `github`, then the owner and name. Undefined with no
 * origin to read it from.
 */
export function repositoryKey(checkout: string): string | undefined {
	const url = originUrl(checkout)
		?.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	const parts = url?.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+)$/);
	const [, host, path] = parts ?? [];
	if (!host || !path) return undefined;
	return `${host === "github.com" ? "github" : host}:${path}`;
}

/** A tree a session holds, as its presence names it (mycelium's `trees`). */
export interface HeldTree {
	/** The broker's key for it, which is its folder's name. */
	readonly key: string;
	/** `github:owner/name` from origin, or `local:` and the main checkout's folder. */
	readonly repo: string;
	/** The branch a worktree is on. */
	readonly branch?: string;
	/** The commit a snapshot is pinned at. */
	readonly commit?: string;
}

/**
 * The tree checked out at `path` as a presence names it, read from git's
 * own files without running git; nothing when it is no checkout or its
 * HEAD reads as neither a branch nor a commit.
 */
export function heldTreeAt(path: string): HeldTree | undefined {
	const head = headOf(path);
	if (head === undefined) return undefined;
	return {
		key: basename(path),
		repo: repositoryKey(path) ?? `local:${mainCheckoutName(path)}`,
		...head,
	};
}

/** The trees a presence names, keeping each that reads as one. */
export function treesFrom(value: unknown): HeldTree[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((one): HeldTree[] =>
		isRecord(one) && typeof one.key === "string" && typeof one.repo === "string"
			? [
					{
						key: one.key,
						repo: one.repo,
						...(typeof one.branch === "string" ? { branch: one.branch } : {}),
						...(typeof one.commit === "string" ? { commit: one.commit } : {}),
					},
				]
			: [],
	);
}

/**
 * What `session` holds of the trees the broker's records in `dir` name,
 * as a presence says them, sorted by key; nothing with no records.
 *
 * Asked at every publish, so the records are listed again only when
 * their folder changed: each is written beside itself and renamed over,
 * which moves the folder's time. Each held tree's HEAD is read every
 * time, since a branch moves without its record being rewritten.
 */
export function heldTreesOf(
	session: string,
	dir: string | undefined,
): () => { trees?: HeldTree[] } {
	if (dir === undefined) return () => ({});
	let listedAt: number | undefined;
	let paths: string[] = [];
	return () => {
		let changed: number;
		try {
			changed = statSync(dir).mtimeMs;
		} catch {
			// No records folder yet: the broker has cut nothing here.
			return {};
		}
		if (changed !== listedAt) {
			paths = treesHeldBy(session, dir);
			listedAt = changed;
		}
		const trees = paths
			.flatMap((path) => heldTreeAt(path) ?? [])
			.sort((one, other) => one.key.localeCompare(other.key));
		return trees.length > 0 ? { trees } : {};
	};
}

/** The branch a checkout is on, or the commit it is detached at. */
function headOf(
	checkout: string,
): { branch: string } | { commit: string } | undefined {
	const own = ownGitDir(checkout);
	if (own === undefined) return undefined;
	let head: string;
	try {
		head = readFileSync(join(own, "HEAD"), "utf8").trim();
	} catch {
		// No HEAD to read is no tree to name.
		return undefined;
	}
	const branch = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1];
	if (branch) return { branch };
	return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)
		? { commit: head }
		: undefined;
}

/**
 * The folder of the main checkout a checkout shares its git directory
 * with, by name: its own for a plain checkout, the one its worktrees
 * hang off otherwise, and a bare repository's own name without `.git`.
 */
function mainCheckoutName(checkout: string): string {
	const common = commonGitDir(checkout);
	return basename(common) === ".git"
		? basename(dirname(common))
		: basename(common).replace(/\.git$/, "");
}

/** The URL of a checkout's origin remote, read from git's own config. */
function originUrl(checkout: string): string | undefined {
	try {
		const config = readFileSync(join(commonGitDir(checkout), "config"), "utf8");
		const origin = config
			.split(/^\[/m)
			.find((section) => section.startsWith('remote "origin"]'));
		return origin?.match(/^\s*url\s*=\s*(\S+)\s*$/m)?.[1];
	} catch {
		return undefined;
	}
}

/**
 * The git directory a checkout shares with its siblings: its own `.git`
 * folder, or for a worktree the one its `.git` file points through.
 */
function commonGitDir(checkout: string): string {
	const dotGit = join(checkout, ".git");
	const own = ownGitDir(checkout);
	if (own === undefined || own === dotGit) return dotGit;
	try {
		const common = readFileSync(join(own, "commondir"), "utf8").trim();
		return isAbsolute(common) ? common : join(own, common);
	} catch {
		return dirname(dirname(own));
	}
}

/**
 * A checkout's own git directory: its `.git` folder, or for a worktree
 * the one its `.git` file points at; nothing when it has neither.
 */
function ownGitDir(checkout: string): string | undefined {
	const dotGit = join(checkout, ".git");
	let pointer: string;
	try {
		pointer = readFileSync(dotGit, "utf8");
	} catch {
		// A folder can't be read as a file: that is a plain checkout's.
		return existsSync(dotGit) ? dotGit : undefined;
	}
	const gitDir = pointer.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
	if (!gitDir) return undefined;
	return isAbsolute(gitDir) ? gitDir : join(checkout, gitDir);
}
