/**
 * Cutting trees with plain git.
 *
 * The general case, so that the broker works before anything
 * downstream registers. A repo with a checkout on disk gets a git
 * worktree beside the state directory, detached at a commit for a
 * snapshot or on its branch for a worktree.
 *
 * It deliberately does not clone. A repo known only by a remote is
 * refused with the remote named, because a clone of an unasked-for
 * repo can be enormous and quietly spending ten minutes on one is a
 * surprising thing for a tool to do on its own. Saying what is
 * needed leaves the choice with whoever knows how big it is; a
 * downstream provider that knows a particular repo can serve it
 * without asking.
 */

import { join } from "node:path";
import { type Exec, run } from "../../review/index.js";
import type { TreeProvider } from "../broker.js";
import { treeIdentity, treeSource } from "../tree.js";

/** The built-in provider's id, and the general case's specificity. */
const ID = "git-worktree";
const GENERAL = 0;

/**
 * A tree provider backed by `git worktree`.
 *
 * Applies to every repo, since git is what the general case means.
 * Anything more specific outranks it by declaring a higher
 * specificity.
 */
export function createGitTreeProvider(deps: {
	exec: Exec;
	stateDir: string;
}): TreeProvider {
	return {
		id: ID,
		specificity: GENERAL,
		appliesTo: () => true,

		async ensure(request) {
			const source = treeSource(request.repo);
			if (source.kind === "unknown") {
				throw new Error(
					`Nothing is known about where ${request.repo.key} lives, locally or by remote, so there is nowhere to cut a tree from.`,
				);
			}
			if (source.kind === "clone") {
				throw new Error(
					`${request.repo.key} is known only as ${source.remoteUrl}, and cloning a repo you did not ask for can take a very long time. Clone it yourself, or register a provider that knows this repo.`,
				);
			}

			const path = join(deps.stateDir, treeIdentity(request).key);

			// Already there is the ordinary case, not a failure. `ensure` means
			// make sure it exists, a snapshot is shareable between readers by
			// design, and the broker holding one only remembers for as long as
			// the session does while the directory outlives it. So the second
			// session to review a commit found the tree its predecessor cut and
			// died on `fatal: already exists`, then fell back to letting
			// reviewers read the working checkout.
			const standing = await deps.exec("git", [
				"-C",
				path,
				"rev-parse",
				"HEAD",
			]);
			if (standing.code === 0) {
				const head = standing.stdout.trim();
				// A snapshot's commit is part of its identity, so a tree under
				// this name standing anywhere else is not the thing being asked
				// for. Refuse rather than hand it over: silently reviewing a
				// different commit is the one outcome nobody could detect.
				if (request.intent === "snapshot" && head !== request.commit) {
					throw new Error(
						`A tree for ${request.repo.key} already sits at ${path} but stands at ${head} rather than ${request.commit}. Release it before pinning a snapshot there.`,
					);
				}
				return { path };
			}

			const at =
				request.intent === "snapshot"
					? ["--detach", path, request.commit]
					: [path, request.branch];
			await run(
				deps.exec,
				"git",
				["-C", source.path, "worktree", "add", ...at],
				`Cutting a tree for ${request.purpose}`,
			);
			return { path };
		},

		async release(held) {
			// Scoped to the tree itself, which is the one repo guaranteed
			// to know about it. Without a -C this ran against whatever
			// repo the process happened to be sitting in, and git then
			// reports that the path is not a working tree, which is true
			// of that repo and beside the point. A worktree's .git file
			// names its main repo, so asking from inside is enough and
			// needs no source path carried on the held tree.
			await run(
				deps.exec,
				"git",
				["-C", held.path, "worktree", "remove", held.path],
				`Releasing the tree at ${held.path}`,
			);
		},
	};
}
