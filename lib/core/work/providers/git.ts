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

import { lstatSync, readdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { displayPath } from "../../../ui/path.ts";
import { type Exec, run } from "../../exec/index.ts";
import { withoutCredentials } from "../../remote/index.ts";
import { fullRefRefusal } from "../author.ts";
import type { TreeProvider } from "../broker.ts";
import { FETCHED_LATELY_MS, refreshStart } from "../fresh-start.ts";
import { dropMergedBranch } from "../merged-branch.ts";
import {
	cutRunning,
	forgetGoneEntry,
	GUARD_WORDS,
	handLocked,
	handLockedIn,
	looksCut,
	plainWords,
	strandedWhy,
} from "../stranded.ts";
import { type TreeRequest, treeIdentity, treeSource } from "../tree.ts";

/**
 * The exit code the fence's guard answers a git it won't run with, as a
 * shell's for a command it won't run. Said again here rather than shared
 * with the guard, since the work core imports nothing of the sandbox's.
 */
const GUARD_REFUSED = 126;

/**
 * Why a tree at `path` git didn't read can be neither handed over nor
 * cut over, and the way out that fits it. Only a worktree whose git
 * folder is gone, or one the guard won't run git in, is what tidy lists
 * and reclaim sets aside; anything else, a git that failed or timed
 * out, or a folder that isn't a cut worktree, may read next time, or is
 * somebody's to move by hand. A hand lock's way out names `clone`, the
 * checkout the cut comes from, since the tree's `.git` names a folder a
 * sandboxed command could have written, where git would run its hooks.
 * The lock is read through the tree's `.git` and through `clone`'s own
 * entry for the path, which still names it where that `.git` points
 * elsewhere, as it does once the clone has moved.
 */
function unreadTree(
	path: string,
	standing: { code: number; stderr: string },
	intent: string,
	clone: string | undefined,
): string {
	const gone = strandedWhy(path, () => undefined);
	// The guard's own words name a path a fenced command can choose, so
	// what it refused is said in words of ours rather than repeated.
	const said =
		gone ??
		(standing.code === GUARD_REFUSED
			? GUARD_WORDS
			: plainWords(
					standing.stderr.trim() || `git exited ${standing.code} reading it`,
				));
	const why = /[.!?]$/.test(said) ? said : `${said}.`;
	const where = `${displayPath(path)} already holds a tree, which git here won't read: ${why}`;
	const cloneGit = clone === undefined ? undefined : gitFolderOf(clone);
	if (
		handLocked(path) ||
		(cloneGit !== undefined && handLockedIn(cloneGit, path))
	) {
		return `${where} Git's entry for it is locked for a reason other than the English one a cut gives, as \`git worktree lock\` leaves or a cut killed before git here was told English, and nothing here takes that lock away. If nothing in it is wanted, run \`git worktree unlock\` on it from ${clone === undefined ? "the clone that cut it" : `${displayPath(clone)}, the clone this cut comes from`}, never inside it or in a folder its \`.git\` names, which a sandboxed command could have written, then \`work tidy\` says whether \`work reclaim\` can set it aside. Where that clone doesn't know it, another checkout of the repository may have cut it, or a sandboxed command written the lock, so unlock it from a checkout of yours whose \`git worktree list\` names it, never one found through its \`.git\`, or move it aside by hand.`;
	}
	if (cutRunning(path)) {
		return `${where} git marks it locked, as it does while another session cuts it, so ask again in a minute. A lock an hour old is taken as one a killed cut left.`;
	}
	if (
		looksCut(path) &&
		(gone !== undefined || standing.code === GUARD_REFUSED)
	) {
		return `${where} Nothing can hand it over or cut there until it goes. Once nothing holds it or works in it, \`work tidy\` lists it and \`work reclaim\` moves it aside whole, after which this ${intent} can be cut. Where a record from before trees named their owners names it, or this machine can't say what works in a folder, reclaim keeps it, so move it aside by hand.`;
	}
	return `${where} If git was only slow or stopped, ask again. Otherwise move it aside by hand once nothing in it is wanted, after which this ${intent} can be cut.`;
}

/**
 * The git folder of a main checkout, whose `.git` is a folder, or
 * nothing for one whose `.git` is a file or a link, which another could
 * have written.
 */
function gitFolderOf(checkout: string): string | undefined {
	const dotGit = join(checkout, ".git");
	try {
		return lstatSync(dotGit).isDirectory() ? dotGit : undefined;
	} catch {
		// No checkout there to read.
		return undefined;
	}
}

/**
 * Whether anything stands in the folder at `path`. git cuts into an
 * empty folder as readily as a missing one, as it does into a subvolume
 * made for the tree, so only a folder with something in it is in the way.
 */
function holdsAnything(path: string): boolean {
	try {
		return readdirSync(path).length > 0;
	} catch {
		// Nothing there, or not a folder git could cut into either way.
		return false;
	}
}

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
	exec: Exec,
	checkout: string,
	path: string,
	branch: string,
	base: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string[]> {
	const fullName = fullRefRefusal(branch);
	if (fullName) throw new Error(fullName);
	const git = (...args: string[]) => exec("git", ["-C", checkout, ...args]);
	const exists = async (ref: string) =>
		(await git("rev-parse", "--verify", "--quiet", ref)).code === 0;
	// A new branch starts where the remote has its start now, not where
	// the checkout's last fetch left it: trees cut from a checkout that
	// had not fetched since a merge came out a merge behind. A fetch that
	// fails leaves the start as it was, since offline work is still work,
	// and one a fetch moved lately is taken as it stands (fresh-start.ts).
	const fresh = async (from: string) =>
		(
			await refreshStart(exec, checkout, from, signal, {
				fetchedWithin: FETCHED_LATELY_MS,
			})
		).start;
	if (await exists(`refs/heads/${branch}`)) return [path, branch];
	if (await exists(`refs/remotes/origin/${branch}`)) {
		return ["--track", "-b", branch, path, await fresh(`origin/${branch}`)];
	}
	if (await exists(`refs/remotes/${branch}`)) {
		throw new Error(
			`${branch} is a remote's branch, and a local branch of that name would shadow it. To work from it, name the branch to work on and give ${branch} as its base; to read it, take a snapshot.`,
		);
	}
	if (base !== undefined) {
		return ["--no-track", "-b", branch, path, await fresh(base)];
	}
	const head = await git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
	const start =
		head.code === 0 && head.stdout.trim() !== ""
			? await fresh(head.stdout.trim().replace(/^refs\/remotes\//, ""))
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

/**
 * Whether the checkout has a remote it mirrors, as pi-packages keeps
 * its copy of each package. A branch made there lasted until the next
 * timed fetch, which deleted it under the tree working on it.
 */
async function mirrors(
	git: (...args: string[]) => ReturnType<Exec>,
): Promise<boolean> {
	const said = await git(
		"config",
		"--type=bool",
		"--get-regexp",
		"^remote\\..*\\.mirror$",
	);
	return (
		said.code === 0 &&
		said.stdout.split("\n").some((line) => line.trim().endsWith(" true"))
	);
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

/** Where a checkout's own branches live. */
const BRANCH_REFS = "refs/heads/";

/**
 * The branch a tree stands on and the checkout that holds it, or
 * nothing for a tree on a bare commit. Read before the tree goes, since
 * after it there is nothing left to ask.
 */
async function standsOn(
	exec: Exec,
	tree: string,
): Promise<{ name: string; checkout: string } | undefined> {
	// The full ref, not --short: a short name is the shortest that is
	// unambiguous, which for a branch sharing a tag's or a remote's name
	// is not the branch's own, and HEAD may point somewhere not a branch.
	const on = await exec("git", ["-C", tree, "symbolic-ref", "--quiet", "HEAD"]);
	const ref = on.code === 0 ? on.stdout.trim() : "";
	if (!ref.startsWith(BRANCH_REFS)) return undefined;
	const name = ref.slice(BRANCH_REFS.length);
	if (name === "") return undefined;
	const common = await exec("git", [
		"-C",
		tree,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (common.code !== 0 || common.stdout.trim() === "") return undefined;
	return { name, checkout: common.stdout.trim() };
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
	/**
	 * Runs git for a call nobody can stop. It, and `execFor`'s git too,
	 * must run git in its own English, as the broker's do with
	 * `LANGUAGE=en`: a cut's lock holds the word git writes while it
	 * fills a tree, which a re-cut and reclaim read to tell a killed
	 * cut's lock from a hand lock.
	 */
	exec: Exec;
	/**
	 * Runs git for a call that can be stopped, stopping git with it, in
	 * English as `exec` does.
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
			// Something stands there that git won't read, so cutting over it
			// can only fail: on 20 November a snapshot cut from a clone the
			// fence doesn't guard made every later one at its commit die on
			// git's bare `already exists`, which says neither why nor what to do.
			if (holdsAnything(path)) {
				throw new Error(
					unreadTree(path, standing, request.intent, request.repo.localPath),
				);
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
				if (await mirrors(git)) {
					throw new Error(
						`${displayPath(source.path)} is a mirror: every fetch makes its branches match its remote's, so a branch made in a tree cut from it is gone at the next one, and git commits the whole tree as a new history in its place. Cut the worktree from a working checkout of ${request.repo.key}, or take a snapshot to read it.`,
					);
				}
				at = await branchArgs(
					exec,
					source.path,
					path,
					request.branch,
					request.baseBranch,
					options?.signal,
				);
			}
			// git fills an empty directory as readily as it makes one. A
			// subvolume that can't be made, `btrfs` missing say, leaves git
			// to make a plain one, as it always did.
			const apart =
				(await subvolumes(deps.stateDir)) &&
				(await exec("btrfs", ["subvolume", "create", path])).code === 0;
			const add = () =>
				exec("git", ["-C", source.path, "worktree", "add", ...at]);
			let cut = await add();
			// A tree set aside from under this checkout leaves git's entry for
			// it naming a folder that is no longer there, locked too when a
			// killed cut left it, and git then refuses the name. That one
			// entry is forgotten and the cut asked once more, rather than a
			// prune, which would forget every gone tree's entry in the clone.
			// Which entry it is is read from the clone's own files rather than
			// git's words, which a git in another language says otherwise.
			if (cut.code !== 0) {
				const common = await exec("git", [
					"-C",
					source.path,
					"rev-parse",
					"--path-format=absolute",
					"--git-common-dir",
				]);
				if (common.code === 0 && forgetGoneEntry(common.stdout.trim(), path)) {
					cut = await add();
				}
			}
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
			const exec = execOf(options?.signal);
			const branch = await standsOn(exec, held.path);
			await run(
				exec,
				"git",
				["-C", held.path, "worktree", "remove", held.path],
				`Releasing the tree at ${displayPath(held.path)}`,
			);
			// Its branch goes too once trunk has every commit on it, with the
			// config section a push wrote; anything else keeps it.
			if (branch) await dropMergedBranch(exec, branch.checkout, branch.name);
		},
	};
}
