/**
 * What a tree currently holds, and whether anything may move it.
 *
 * The working layer needs this before it re-points a tree, because
 * stepping through a stack means checking a different commit out of
 * a directory somebody may be working in. Overwriting a modified
 * file is bad; overwriting an untracked one is unrecoverable, so an
 * untracked file counts as work here rather than as noise.
 */

import { displayPath } from "../../ui/path.ts";
import { type Exec, run } from "../exec/index.ts";
import type { LocalBranch, WorktreeOnDisk } from "./tidy.ts";

/** One path git reports as changed, and how. */
export interface ChangedPath {
	path: string;
	/** Staged for commit, as opposed to modified in the tree. */
	staged: boolean;
	kind: "modified" | "added" | "deleted" | "renamed" | "untracked";
}

/** What a tree holds beyond its last commit. */
export interface WorkingState {
	clean: boolean;
	changed: readonly ChangedPath[];
}

/**
 * Where a tree points.
 *
 * `branch` is absent rather than empty when the tree is detached. A
 * snapshot is detached by design, so inventing a name would make
 * every snapshot look like a branch tree.
 */
export interface TreeHead {
	commit: string;
	branch?: string;
}

/** Reading a tree's current state. */
export interface WorkHistory {
	status(treePath: string): Promise<WorkingState>;
	head(treePath: string): Promise<TreeHead>;
	/**
	 * Every local branch, with what trunk and the remote say about it.
	 *
	 * Reported rather than acted on: deciding what is spent is
	 * {@link tidyPlan}'s job, and it needs all three facts together to
	 * tell a squash merge from lost work.
	 */
	branches(treePath: string, trunk: string): Promise<LocalBranch[]>;
	/**
	 * Every worktree git tracks for this repo, with what is in each.
	 *
	 * Reported rather than acted on, for the same reason as
	 * {@link branches}: whether a tree has been left behind is
	 * {@link orphanedTrees}'s decision, and it needs the merge state and
	 * the dirty state together to tell an abandoned tree from the only
	 * copy of somebody's work.
	 */
	worktrees(treePath: string, trunk: string): Promise<WorktreeOnDisk[]>;
}

/** Porcelain v1 status codes, mapped to what they mean. */
const KIND: Record<string, ChangedPath["kind"]> = {
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "added",
	U: "modified",
};

/**
 * Read one porcelain v1 line.
 *
 * The format is two status columns then a space then the path, and a
 * rename carries both names as `old -> new`. The new name is the one
 * that matters: it is what is on disk, and what a re-point would
 * overwrite.
 */
function parseLine(line: string): ChangedPath | undefined {
	if (line.length < 4) return undefined;
	const [x, y] = [line[0], line[1]];
	const raw = line.slice(3);
	const path = raw.includes(" -> ") ? raw.split(" -> ")[1] : raw;
	if (path === undefined || path === "") return undefined;
	if (x === "?" && y === "?") {
		return { path, staged: false, kind: "untracked" };
	}
	const staged = x !== " " && x !== "?";
	const code = staged ? x : y;
	const kind = code === undefined ? undefined : KIND[code];
	if (kind === undefined) return undefined;
	return { path, staged, kind };
}

/** Read a tree's state with plain git. */
export function createGitHistory(deps: { exec: Exec }): WorkHistory {
	/**
	 * Whether any branch, remote-tracking branch or tag holds `commit`.
	 *
	 * One ref is enough to answer, so the listing stops at the first.
	 */
	const held = async (treePath: string, commit: string): Promise<boolean> =>
		(
			await run(
				deps.exec,
				"git",
				[
					"-C",
					treePath,
					"for-each-ref",
					"--count=1",
					`--contains=${commit}`,
					"refs/heads",
					"refs/remotes",
					"refs/tags",
				],
				`Asking whether a branch holds ${commit.slice(0, 12)}`,
			)
		).trim() !== "";

	return {
		async status(treePath) {
			const out = await run(
				deps.exec,
				"git",
				["-C", treePath, "status", "--porcelain=v1", "--untracked-files=all"],
				`Reading what ${displayPath(treePath)} holds`,
			);
			const changed = out
				.split("\n")
				.map((line) => parseLine(line))
				.filter((entry): entry is ChangedPath => entry !== undefined);
			return { clean: changed.length === 0, changed };
		},

		async head(treePath) {
			const commit = (
				await run(
					deps.exec,
					"git",
					["-C", treePath, "rev-parse", "HEAD"],
					`Reading where ${displayPath(treePath)} points`,
				)
			).trim();
			// A detached tree makes this fail rather than answer, which
			// is the answer: there is no branch to name.
			const branch = await deps.exec("git", [
				"-C",
				treePath,
				"symbolic-ref",
				"--short",
				"HEAD",
			]);
			if (branch.code !== 0) return { commit };
			const name = branch.stdout.trim();
			return name === "" ? { commit } : { commit, branch: name };
		},

		async branches(treePath, trunk) {
			// One pass for the whole picture. Asking `--merged` separately
			// and joining the answers means two listings taken at different
			// moments, and the join is on a name that can move between them.
			const listed = await run(
				deps.exec,
				"git",
				[
					"-C",
					treePath,
					"for-each-ref",
					"--format=%(refname:short)\t%(upstream:short)\t%(upstream:track,nobracket)",
					"refs/heads",
				],
				`Listing the branches in ${displayPath(treePath)}`,
			);
			const merged = new Set(
				(
					await run(
						deps.exec,
						"git",
						[
							"-C",
							treePath,
							"branch",
							"--format=%(refname:short)",
							"--merged",
							trunk,
						],
						`Asking which branches ${trunk} already contains`,
					)
				)
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line !== ""),
			);

			return listed
				.split("\n")
				.map((line) => line.split("\t"))
				.filter(([name]) => name !== undefined && name !== "")
				.map(([name, upstream, track]) => ({
					name: name as string,
					mergedIntoTrunk: merged.has(name as string),
					...(upstream ? { tracking: upstream } : {}),
					// Git spells a vanished upstream "gone" in the track field,
					// which is the only place it says so without a fetch.
					...(track === "gone" ? { remoteGone: true } : {}),
				}));
		},

		async worktrees(treePath, trunk) {
			// Porcelain, because the human-readable listing puts the branch
			// in square brackets and a detached tree in the same column, so
			// parsing it means telling those apart by punctuation.
			const listed = await run(
				deps.exec,
				"git",
				["-C", treePath, "worktree", "list", "--porcelain"],
				`Listing the worktrees beside ${displayPath(treePath)}`,
			);
			const merged = new Set(
				(
					await run(
						deps.exec,
						"git",
						[
							"-C",
							treePath,
							"branch",
							"--format=%(refname:short)",
							"--merged",
							trunk,
						],
						`Asking which branches ${trunk} already contains`,
					)
				)
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line !== ""),
			);

			// A porcelain record is a run of lines per tree, separated by a
			// blank one: `worktree <path>`, `HEAD <commit>`, then optionally
			// `branch <ref>` or `detached`, and `prunable <why>` once the
			// tree's folder has gone.
			const trees: WorktreeOnDisk[] = [];
			for (const record of listed.split("\n\n")) {
				let path: string | undefined;
				let commit: string | undefined;
				let branch: string | undefined;
				let gone = false;
				for (const line of record.split("\n")) {
					if (line.startsWith("worktree ")) path = line.slice(9).trim();
					if (line.startsWith("HEAD ")) commit = line.slice(5).trim();
					if (line.startsWith("branch ")) {
						branch = line
							.slice(7)
							.trim()
							.replace(/^refs\/heads\//, "");
					}
					if (line === "prunable" || line.startsWith("prunable ")) gone = true;
				}
				// A tree whose folder has gone is only git's record of it, with
				// nothing on disk to reclaim; `git worktree prune` is what clears
				// that. Asking its status failed instead, and one such record
				// stopped the survey of every other tree beside it.
				if (!path || gone) continue;
				// Asked per tree, because a dirty tree is the one refusal here
				// that cannot be recovered from and no listing reports it.
				const state = await this.status(path);
				const kept =
					!branch && commit !== undefined && (await held(treePath, commit));
				trees.push({
					path,
					...(branch ? { branch } : {}),
					...(state.clean ? {} : { dirty: true }),
					...(branch && merged.has(branch) ? { mergedIntoTrunk: true } : {}),
					...(kept ? { commitKept: true } : {}),
				});
			}
			return trees;
		},
	};
}

/** How many paths a refusal names before it summarises. */
const NAMED_IN_REFUSAL = 5;

/**
 * Why a tree may not be re-pointed, or nothing if it may.
 *
 * Returns the sentence rather than a boolean, because a refusal that
 * does not say what is in the way leaves the person to go and look,
 * which is the entire cost of refusing.
 */
export function blocksRepoint(state: WorkingState): string | undefined {
	if (state.clean) return undefined;
	const named = state.changed.slice(0, NAMED_IN_REFUSAL).map((c) => c.path);
	const rest = state.changed.length - named.length;
	const tail = rest > 0 ? `, and ${rest} more` : "";
	return `This tree is holding uncommitted work (${named.join(", ")}${tail}), so re-pointing it would throw that away. Commit it, stash it, or ask for a different tree.`;
}
