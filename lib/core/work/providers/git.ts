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

import { statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { displayPath } from "../../../ui/path.ts";
import { type Exec, run } from "../../exec/index.ts";
import { withoutCredentials } from "../../remote/index.ts";
import { fullRefRefusal } from "../author.ts";
import type { TreeProvider } from "../broker.ts";
import { type TreeRequest, treeIdentity, treeSource } from "../tree.ts";

/**
 * Whether a tree standing at `head` is the commit asked for. A short id
 * names the full one it begins, which is how people write commits; a
 * snapshot pinned by one was refused against itself.
 */
function sameCommit(head: string, asked: string): boolean {
	if (head === asked) return true;
	return /^[0-9a-f]{7,}$/i.test(asked) && head.startsWith(asked.toLowerCase());
}

/**
 * How to check a worktree out on `branch`, whether or not it exists.
 *
 * A branch that is here is checked out as it is. One only origin has is
 * made to follow origin's. One nobody has yet is made from the base asked
 * for, or origin's default, tracking nothing: `worktree add` without `-b`
 * refused every new name with `invalid reference`, and a branch that
 * tracked origin's default had its leased push compared against main.
 *
 * A remote's branch, such as `origin/main`, is refused rather than made:
 * nothing local or on origin bore that name, so a local branch called
 * origin/main was made, and it shadowed origin's own in every command
 * that named it from then on.
 */
async function branchArgs(
	git: (...args: string[]) => ReturnType<Exec>,
	path: string,
	branch: string,
	base: string | undefined,
): Promise<string[]> {
	const fullName = fullRefRefusal(branch);
	if (fullName) throw new Error(fullName);
	const exists = async (ref: string) =>
		(await git("rev-parse", "--verify", "--quiet", ref)).code === 0;
	if (await exists(`refs/heads/${branch}`)) return [path, branch];
	if (await exists(`refs/remotes/origin/${branch}`)) {
		return ["--track", "-b", branch, path, `origin/${branch}`];
	}
	if (await exists(`refs/remotes/${branch}`)) {
		throw new Error(
			`${branch} is a remote's branch, and a local branch of that name would shadow it. To work from it, name the branch to work on and give ${branch} as its base; to read it, take a snapshot.`,
		);
	}
	if (base !== undefined) return ["--no-track", "-b", branch, path, base];
	const head = await git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
	const start =
		head.code === 0 && head.stdout.trim() !== ""
			? head.stdout.trim().replace(/^refs\/remotes\//, "")
			: "HEAD";
	return ["--no-track", "-b", branch, path, start];
}

/**
 * What to say when git will not cut a tree: git's own words, and when
 * another checkout holds the branch, the remedy that works. Git keeps
 * one checkout per branch, so a tree on `main` beside the main checkout
 * can only be a new branch from it, or a snapshot to read.
 */
function cutFailure(said: string, request: TreeRequest): string {
	const words = said.trim();
	const held = words.match(
		/already (?:used by worktree|checked out) at '([^']+)'/,
	);
	if (request.intent === "worktree" && held) {
		return `${words}\n${request.branch} is checked out at ${displayPath(held[1] ?? "")}, and git keeps one checkout per branch. Cut this tree on a new branch, which is made from ${request.branch} when you name it as the base, or take a snapshot to read it.`;
	}
	return `Cutting a tree for ${request.purpose} failed: ${words}`;
}

/** What statfs reports for a btrfs filesystem. */
const BTRFS_MAGIC = 0x9123683e;

/** A commit's full id, the only form git will fetch by. */
const FULL_COMMIT = /^[0-9a-f]{40}$/i;

/**
 * Whether trees under `dir` sit on btrfs, asked of the nearest folder
 * that exists, since the state directory is made with the first tree.
 */
export async function onBtrfs(dir: string): Promise<boolean> {
	for (let at = dir; ; at = dirname(at)) {
		try {
			return (await statfs(at)).type === BTRFS_MAGIC;
		} catch {
			if (dirname(at) === at) return false;
		}
	}
}

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
	/** Runs git for a call nobody can stop. */
	exec: Exec;
	/**
	 * Runs git for a call that can be stopped, stopping git with it.
	 * Without it every call uses `exec`, and a stop reaches only the
	 * promise waiting on git rather than git itself.
	 */
	execFor?: (signal: AbortSignal) => Exec;
	stateDir: string;
	/**
	 * Whether each tree under the state directory is a subvolume of its
	 * own. On btrfs, every file under one subvolume shares its tree lock
	 * and log, so builds in a tree beside Joel's files held up an app's
	 * save: p99 600 ms beside 20 builds, 18 ms with them apart. Asks the
	 * filesystem unless told.
	 */
	subvolumes?: (stateDir: string) => Promise<boolean>;
}): TreeProvider {
	const subvolumes = deps.subvolumes ?? onBtrfs;
	const execOf = (signal: AbortSignal | undefined): Exec =>
		signal !== undefined && deps.execFor !== undefined
			? deps.execFor(signal)
			: deps.exec;
	return {
		id: ID,
		specificity: GENERAL,
		appliesTo: () => true,

		async ensure(request, options) {
			const exec = execOf(options?.signal);
			const source = treeSource(request.repo);
			if (source.kind === "unknown") {
				throw new Error(
					`Nothing is known about where ${request.repo.key} lives, locally or by remote, so there is nowhere to cut a tree from.`,
				);
			}
			if (source.kind === "clone") {
				throw new Error(
					`${request.repo.key} is known only as ${withoutCredentials(source.remoteUrl)}, and cloning a repo you did not ask for can take a very long time. Clone it yourself, or register a provider that knows this repo.`,
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
			const standing = await exec("git", ["-C", path, "rev-parse", "HEAD"]);
			if (standing.code === 0) {
				const head = standing.stdout.trim();
				// A snapshot's commit is part of its identity, so a tree under
				// this name standing anywhere else is not the thing being asked
				// for. Refuse rather than hand it over: silently reviewing a
				// different commit is the one outcome nobody could detect.
				if (
					request.intent === "snapshot" &&
					!sameCommit(head, request.commit)
				) {
					throw new Error(
						`A tree for ${request.repo.key} already sits at ${displayPath(path)} but stands at ${head} rather than ${request.commit}. Release it before pinning a snapshot there.`,
					);
				}
				// A worktree is named for the branch it was cut on, and work moves
				// trees to other branches. One moved since was handed to the next
				// caller asking for the first branch, who then worked on the
				// other one believing it theirs.
				if (request.intent === "worktree") {
					const on = await exec("git", [
						"-C",
						path,
						"symbolic-ref",
						"--quiet",
						"--short",
						"HEAD",
					]);
					const branch = on.code === 0 ? on.stdout.trim() : "";
					if (branch !== request.branch) {
						const where =
							branch === ""
								? `stands detached at ${head.slice(0, 12)} rather than on ${request.branch}`
								: `stands on ${branch} rather than ${request.branch}`;
						const remedy =
							branch === ""
								? "Release it to cut a fresh one"
								: `Release it to cut a fresh one, or ask for ${branch} to work on it as it is`;
						throw new Error(
							`The tree cut for ${request.branch} at ${displayPath(path)} ${where}, so it is not the tree asked for. ${remedy}.`,
						);
					}
				}
				return { path };
			}

			const git = (...args: string[]) =>
				exec("git", ["-C", source.path, ...args]);
			let at: string[];
			if (request.intent === "snapshot") {
				// A commit somebody else pushed is often not here yet, which
				// left a review reading the checkout at whatever commit it
				// stood on. Asking origin for it costs one fetch, and when
				// origin will not give it, git's refusal below says so.
				const has = async () =>
					(await git("cat-file", "-e", `${request.commit}^{commit}`)).code ===
					0;
				if (!(await has())) {
					// git fetches by a full id only, so a short one is looked
					// for on origin's branches, where a commit somebody means
					// usually is. Fetched by its short id, a merge just made on
					// main came to nothing and the cut failed "invalid reference".
					const full = FULL_COMMIT.test(request.commit);
					await git(
						"fetch",
						"--quiet",
						"--no-tags",
						"origin",
						...(full ? [request.commit] : []),
					);
					if (!full && !(await has())) {
						throw new Error(
							`${request.commit} is in neither ${request.repo.key}'s checkout nor origin's branches. Give the commit's full id, which origin can be asked for directly.`,
						);
					}
				}
				at = ["--detach", path, request.commit];
			} else {
				at = await branchArgs(git, path, request.branch, request.baseBranch);
			}
			// git fills an empty directory as readily as it makes one. A
			// subvolume that can't be made, `btrfs` missing say, leaves git
			// to make a plain one, as it always did.
			const apart =
				(await subvolumes(deps.stateDir)) &&
				(await exec("btrfs", ["subvolume", "create", path])).code === 0;
			const cut = await exec("git", [
				"-C",
				source.path,
				"worktree",
				"add",
				...at,
			]);
			if (cut.code !== 0) {
				// An empty subvolume goes with rmdir, as its owner.
				if (apart) await exec("rmdir", [path]);
				throw new Error(cutFailure(cut.stderr || cut.stdout, request));
			}
			return { path };
		},

		async release(held, options) {
			// Scoped to the tree itself, which is the one repo guaranteed
			// to know about it. Without a -C this ran against whatever
			// repo the process happened to be sitting in, and git then
			// reports that the path is not a working tree, which is true
			// of that repo and beside the point. A worktree's .git file
			// names its main repo, so asking from inside is enough and
			// needs no source path carried on the held tree.
			await run(
				execOf(options?.signal),
				"git",
				["-C", held.path, "worktree", "remove", held.path],
				`Releasing the tree at ${displayPath(held.path)}`,
			);
		},
	};
}
