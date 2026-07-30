/**
 * Turning a loose ask into a tree request, or a sentence saying
 * why not.
 *
 * The broker takes a `TreeRequest` whose two shapes need
 * different fields, and a tool surface takes whatever the caller
 * sent. Somewhere in between, a caller who sent a commit where a
 * branch belonged has to be told that specifically, rather than
 * being handed a generic complaint or, worse, having the provider
 * fail somewhere further from the cause.
 *
 * This is where. It is pure, so the refusals can be read as a set
 * rather than discovered one live call at a time.
 */

import type { TreeRequest } from "./tree.js";

/** A repo, as loosely as a caller may name one. */
export interface AskedRepo {
	key: string;
	remoteUrl?: string;
	localPath?: string;
}

/** What a caller asked for, before it is known to be coherent. */
export interface TreeAsk {
	intent: "worktree" | "snapshot";
	repo: AskedRepo;
	purpose: string;
	branch?: string;
	commit?: string;
	paths?: readonly string[];
}

/** Either a request the broker will accept, or why it will not. */
export type TreeRequestOutcome = { request: TreeRequest } | { refusal: string };

/** Build a tree request, or refuse with the missing part named. */
export function treeRequestFrom(ask: TreeAsk): TreeRequestOutcome {
	const purpose = ask.purpose?.trim();
	if (!purpose) {
		return {
			refusal:
				"Say what the tree is for: the purpose names it, so without " +
				"one there is nothing to call it or to recognise it by later.",
		};
	}

	// Neither on disk nor reachable is a dead end, and the provider
	// would otherwise be the one to discover it, further from the
	// cause and with less to say about it.
	if (!ask.repo.localPath && !ask.repo.remoteUrl) {
		return {
			refusal:
				`No tree can be cut for ${ask.repo.key}: it has neither a ` +
				"local checkout nor a remote. Name one of the two.",
		};
	}

	if (ask.intent === "worktree") {
		if (!ask.branch) {
			// Having been sent a commit is a different mistake from
			// having sent nothing, and worth separating: one caller
			// forgot a field, the other chose the wrong one.
			const instead = ask.commit
				? ` A commit (${ask.commit}) was given instead; a worktree ` +
					"is checked out at a branch, so ask for a snapshot if you " +
					"meant to pin that commit."
				: "";
			return {
				refusal: `A worktree needs a branch to check out.${instead}`,
			};
		}
		return {
			request: {
				intent: "worktree",
				repo: ask.repo,
				purpose,
				branch: ask.branch,
			},
		};
	}

	if (!ask.commit) {
		const instead = ask.branch
			? ` A branch (${ask.branch}) was given instead; a snapshot is ` +
				"pinned to one commit, so ask for a worktree if you meant to " +
				"work on that branch."
			: "";
		return {
			refusal: `A snapshot needs a commit to pin.${instead}`,
		};
	}
	return {
		request: {
			intent: "snapshot",
			repo: ask.repo,
			purpose,
			commit: ask.commit,
			...(ask.paths ? { paths: ask.paths } : {}),
		},
	};
}
