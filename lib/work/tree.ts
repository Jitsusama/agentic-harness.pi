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
