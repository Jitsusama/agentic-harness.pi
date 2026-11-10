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
	worktrees(
		treePath: string,
		trunk: string,
		options?: WorktreeAsk,
	): Promise<WorktreeOnDisk[]>;
}

/** What a caller already knows before the trees are read. */
interface WorktreeAsk {
	/**
	 * Whether the caller keeps this tree whatever it holds, given the
	 * path as git names it. A kept tree is listed with its branch but
	 * asked nothing more: no status, and no question about its commit.
	 */
	readonly kept?: (path: string) => boolean;
	/**
	 * What each tree's status runs through, so a caller can give it a
	 * clock of its own: one World tree took 733 s, and every other tree
	 * waited on it. A tree whose status fails or runs out is reported
	 * unread, never as clean. The history's own exec when absent.
	 */
	readonly statusExec?: Exec;
}

/**
 * How many trees are asked their status at once. A status in a World
 * tree took 0.03 s to 0.8 s at load 35, and World had 253 trees.
 */
const STATUS_AT_ONCE = 8;

/**
 * Every status read here goes without git's fsmonitor daemon. Where it
 * is configured on, as dev configures it, a status starts one daemon a
 * tree, which never exits: on 10 November 265 of them held 778 MiB and
 * 60,846 inotify watches, 201 started by one reclaim across World's
 * trees (2AF2DH [c9039904]). Status reads the same without it.
 */
const NO_FSMONITOR = ["-c", "core.fsmonitor=false"];

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
	 * Which of `commits` some branch, remote-tracking branch or tag holds.
	 *
	 * One walk for all of them: it lists what the commits reach that no
	 * ref does, so a commit it lists is one no ref holds. Asking per
	 * commit with `for-each-ref --contains` took 14 s to 102 s a commit
	 * against World's 4,000 refs, and World had 102 detached trees; this
	 * walk answered all 102 in 27 s. `--all` would be wrong here, since
	 * it counts every tree's own HEAD as a ref.
	 */
	const held = async (
		treePath: string,
		commits: readonly string[],
	): Promise<Set<string>> => {
		if (commits.length === 0) return new Set();
		const unheld = new Set(
			(
				await run(
					deps.exec,
					"git",
					[
						"-C",
						treePath,
						"rev-list",
						...commits,
						"--not",
						"--branches",
						"--remotes",
						"--tags",
					],
					`Asking which of ${commits.length} commits a branch holds`,
				)
			)
				.split("\n")
				.map((line) => line.trim()),
		);
		return new Set(commits.filter((commit) => !unheld.has(commit)));
	};

	return {
		async status(treePath) {
			const out = await run(
				deps.exec,
				"git",
				[
					"-C",
					treePath,
					...NO_FSMONITOR,
					"status",
					"--porcelain=v1",
					"--untracked-files=all",
				],
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
			// The upstream's full name rather than git's track field. Track
			// counts how far each branch is ahead of and behind its upstream,
			// which took 476 s over World's 1,866 branches, to learn only
			// whether the upstream is gone: an upstream no ref listing holds.
			const listed = await run(
				deps.exec,
				"git",
				[
					"-C",
					treePath,
					"for-each-ref",
					"--format=%(refname:short)\t%(upstream:short)\t%(upstream)",
					"refs/heads",
				],
				`Listing the branches in ${displayPath(treePath)}`,
			);
			const refs = new Set(
				(
					await run(
						deps.exec,
						"git",
						[
							"-C",
							treePath,
							"for-each-ref",
							"--format=%(refname)",
							"refs/heads",
							"refs/remotes",
						],
						`Listing the refs an upstream can be in ${displayPath(treePath)}`,
					)
				)
					.split("\n")
					.map((line) => line.trim()),
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
				.map(([name, upstream, upstreamRef]) => ({
					name: name as string,
					mergedIntoTrunk: merged.has(name as string),
					...(upstream ? { tracking: upstream } : {}),
					// Configured but missing, which is what git's track field calls
					// gone: the remote dropped it and a prune took the local copy.
					...(upstreamRef && !refs.has(upstreamRef)
						? { remoteGone: true }
						: {}),
				}));
		},

		async worktrees(treePath, trunk, options = {}) {
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
			const found: { path: string; commit?: string; branch?: string }[] = [];
			for (const record of listed.split("\n\n")) {
				let path: string | undefined;
				let commit: string | undefined;
				let branch: string | undefined;
				let gone = false;
				let bare = false;
				for (const line of record.split("\n")) {
					if (line === "bare") bare = true;
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
				// A bare repository's own record is its common dir, with no work
				// tree to ask the status of and nothing checked out to reclaim.
				// Asking failed, and refused the survey of World's 125 trees.
				if (!path || gone || bare) continue;
				found.push({
					path,
					...(commit ? { commit } : {}),
					...(branch ? { branch } : {}),
				});
			}

			// A tree the caller keeps whatever it holds is asked nothing:
			// its status and its commit could not change the answer.
			const asking = found.filter((tree) => !options.kept?.(tree.path));
			// Asked per tree, because a dirty tree is the one refusal here
			// that cannot be recovered from and no listing reports it. Only
			// whether it is clean, so an untracked folder is one line rather
			// than every file in it: the 733 s tree answered in 46 s so.
			const statusExec = options.statusExec ?? deps.exec;
			const dirty = new Set<string>();
			const unread = new Set<string>();
			const waiting = asking[Symbol.iterator]();
			const ask = async (): Promise<void> => {
				for (let next = waiting.next(); !next.done; next = waiting.next()) {
					const { path } = next.value;
					const state = await statusExec("git", [
						"-C",
						path,
						...NO_FSMONITOR,
						"status",
						"--porcelain=v1",
						"--untracked-files=normal",
					]);
					if (state.code !== 0) unread.add(path);
					else if (state.stdout.trim() !== "") dirty.add(path);
				}
			};
			await Promise.all(
				Array.from({ length: Math.min(STATUS_AT_ONCE, asking.length) }, ask),
			);
			const kept = await held(treePath, [
				...new Set(
					asking
						.filter(
							(tree) =>
								!tree.branch && !dirty.has(tree.path) && !unread.has(tree.path),
						)
						.flatMap((tree) => (tree.commit ? [tree.commit] : [])),
				),
			]);

			return found.map(({ path, commit, branch }) => ({
				path,
				...(branch ? { branch } : {}),
				...(dirty.has(path) ? { dirty: true } : {}),
				...(unread.has(path) ? { unread: true } : {}),
				...(branch && merged.has(branch) ? { mergedIntoTrunk: true } : {}),
				...(!branch && commit && kept.has(commit) ? { commitKept: true } : {}),
			}));
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
