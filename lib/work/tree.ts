/**
 * Where a tree for a change gets cut from.
 *
 * This exists because the answer used to be a guess. The review
 * worktree provider resolved a source repo as
 * `~/src/github.com/{owner}/{repo}`, which is correct on GitHub
 * and silently wrong everywhere else: a change on another system
 * resolves to a directory that does not exist, and the failure
 * surfaces as a missing checkout rather than as the assumption it
 * really is. A forge name baked into a path is the hardest kind of
 * assumption to notice, because every test against that forge
 * passes.
 *
 * So the question is answered from what the substrate already
 * knows. A provider that resolved a change has already said where
 * its repo is, locally or by remote, and a repo it could say
 * neither about is reported as unplaceable rather than guessed at.
 */

import type { RepoLocator } from "../review/index.js";

/**
 * Where the source for a tree comes from.
 *
 * Three outcomes rather than a path or nothing, because the caller
 * has to act differently on each: use it, fetch it first, or tell
 * somebody it cannot be found. Collapsing the last two loses the
 * difference between work to do and a question to ask.
 */
export type TreeSource =
	/** A checkout already on disk; cut the tree from here. */
	| { kind: "checkout"; path: string }
	/** Known only by remote, so it has to be fetched first. */
	| { kind: "clone"; remoteUrl: string }
	/** Neither known. Say so; do not invent a path. */
	| { kind: "unknown"; repoKey: string };

/**
 * Decide where a change's tree should be cut from.
 *
 * A local checkout wins over a remote, because it is already
 * there and cutting a tree from it costs a fraction of a fetch.
 */
export function treeSource(repo: RepoLocator): TreeSource {
	if (repo.localPath) return { kind: "checkout", path: repo.localPath };
	if (repo.remoteUrl) return { kind: "clone", remoteUrl: repo.remoteUrl };
	return { kind: "unknown", repoKey: repo.key };
}

/**
 * What a tree is wanted for.
 *
 * Two lifecycles, not three. The review worktrees, the fix
 * worktrees and the quest trees looked like three contracts, but
 * the fix and quest cases differ only in what names them: both are
 * a durable branch you edit in. What actually varies is what the
 * tree is pinned to, and that changes the reuse rule.
 *
 * A `snapshot` is pinned to a commit and read rather than edited,
 * so readers can share one. A `worktree` is pinned to a branch and
 * expects to be committed in, so it belongs to one stream of work.
 */
export type TreeRequest =
	| {
			intent: "snapshot";
			repo: RepoLocator;
			purpose: string;
			commit: string;
			paths?: readonly string[];
	  }
	| {
			intent: "worktree";
			repo: RepoLocator;
			purpose: string;
			branch: string;
			baseBranch?: string;
	  };

/** What a tree is, for the purpose of reusing it. */
export interface TreeIdentity {
	/**
	 * Stable, filesystem-safe name for this tree. Safe to use as
	 * a directory component: repo keys carry colons and change
	 * labels carry slashes and hashes, and a key holding those
	 * either nests where nobody expected a directory or fails
	 * outright.
	 */
	key: string;
	/**
	 * Whether two callers wanting this same tree may be handed
	 * the same one. True for a snapshot, since reading does not
	 * disturb a reader. False for a worktree, because somebody is
	 * editing in it, and that is a property of the intent rather
	 * than a caller's judgement call.
	 */
	shareable: boolean;
}

/** Characters that must not reach a directory name. */
const UNSAFE_IN_PATH = /[^a-zA-Z0-9._-]+/g;

function slug(value: string): string {
	return value.replace(UNSAFE_IN_PATH, "-");
}

/**
 * Work out what tree a request is asking for.
 *
 * A snapshot's identity carries its commit, so asking for another
 * commit asks for another tree. A worktree's identity deliberately
 * does not: the branch moves under it every time you commit, and
 * an identity that moved with HEAD would orphan the tree you are
 * working in on your first commit.
 *
 * Both are scoped to the repo, because a branch name and even a
 * commit can appear in two repos and they are not the same tree.
 *
 * The `paths` a snapshot may narrow itself to are left out. Scoping
 * is a provider's optimisation, not part of what the tree is;
 * folding it in would fragment reuse per distinct file set.
 */
export function treeIdentity(request: TreeRequest): TreeIdentity {
	const repo = slug(request.repo.key);
	if (request.intent === "snapshot") {
		return { key: `snapshot-${repo}-${slug(request.commit)}`, shareable: true };
	}
	return { key: `worktree-${repo}-${slug(request.branch)}`, shareable: false };
}

/**
 * Whether a tree already held answers a fresh request.
 *
 * Compared by identity rather than field by field, so the reuse
 * rule lives in one place and cannot drift between the caller that
 * provisions and the caller that looks one up.
 */
export function satisfies(held: TreeIdentity, request: TreeRequest): boolean {
	return held.key === treeIdentity(request).key;
}
