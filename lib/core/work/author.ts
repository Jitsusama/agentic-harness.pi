/**
 * Recording work: staging, committing, and moving onto a branch.
 *
 * The history facet reads a tree and this one writes to it, kept
 * apart because reading is safe and writing is not. A consumer
 * that only wants to know whether a tree is dirty should not be
 * handed the ability to commit in it.
 *
 * Names are checked here rather than left to git, and not only for
 * the names git would reject anyway. The dangerous ones are the
 * names git accepts: a branch called `-rf` is a valid ref and a
 * flag to every command that later takes it, so it has to be
 * refused before it reaches a command line rather than after.
 */

// The leaf rather than the barrel, so a working layer that never draws anything
// does not pull the TUI in behind one string helper.
import { displayPath } from "../../ui/path.ts";
import { EXIT_ABORTED, type Exec, run } from "../exec/index.ts";

/** What a commit says. */
export interface CommitMessage {
	subject: string;
	body?: string;
}

/** Where a new branch starts. */
export interface BranchOptions {
	from?: string;
}

/** Writing to a tree. */
export interface WorkAuthor {
	/** Stage these paths, or everything when none are named. */
	stage(treePath: string, paths?: readonly string[]): Promise<void>;
	/** Record what is staged. */
	commit(treePath: string, message: CommitMessage): Promise<void>;
	/** Create a branch and check it out. */
	branch(
		treePath: string,
		name: string,
		options?: BranchOptions,
	): Promise<void>;
}

/**
 * Characters and shapes a ref may not carry.
 *
 * This is git's own `check-ref-format` rule set, minus the parts
 * that need a repo to answer, plus the leading dash. Doing it as a
 * deny list rather than an allow list is deliberate: branch names
 * legitimately carry slashes, dots and unicode, and an allow list
 * narrow enough to be safe would refuse names people already use.
 */
const UNSAFE_IN_REF = /[\s~^:?*[\\]|\.\.|^-|^\/|\/$|\.lock$|^$/;

/**
 * Highest code point that is a control character, plus delete.
 *
 * Tested by code point rather than folded into the pattern above,
 * because a regex holding literal control characters is
 * unreadable and reads to a linter as a mistake. The intent is the
 * same and the check is easier to be sure of.
 */
function hasControlCharacter(name: string): boolean {
	for (const character of name) {
		const code = character.codePointAt(0);
		if (code === undefined) continue;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

/**
 * A ref name, trimmed, or nothing when it is not safe to use.
 *
 * Returns the name rather than a boolean so a caller cannot check
 * one string and then pass a different one, which is the shape of
 * mistake that makes a validator decorative.
 */
export function safeBranchName(name: string): string | undefined {
	const trimmed = name?.trim() ?? "";
	if (trimmed === "") return undefined;
	if (hasControlCharacter(trimmed)) return undefined;
	if (UNSAFE_IN_REF.test(trimmed)) return undefined;
	return trimmed;
}

/**
 * Why a ref's full name can't be a branch to make, or nothing when
 * `name` isn't one.
 *
 * Git takes `refs/remotes/origin/main` as a new branch's name and
 * makes `refs/heads/refs/remotes/origin/main`, which then shadows
 * origin's main wherever it is named in full. Nobody means that, so
 * the name is refused with the short one it most likely meant.
 */
export function fullRefRefusal(name: string): string | undefined {
	if (!name.startsWith("refs/")) return undefined;
	const short = name.replace(/^refs\/(?:heads\/|remotes\/[^/]+\/|tags\/)?/, "");
	return (
		`${name} is a ref's full name, and a branch made from it would sit at ` +
		`refs/heads/${name}, shadowing it. To work on a branch, name the branch ` +
		`itself, such as ${short}; to start from ${name}, give it as where the ` +
		"branch starts."
	);
}

/** How long a whole branch name should stay under, by convention. */
const BRANCH_NAME_BUDGET = 40;

/**
 * Where a branch name departs from the house convention.
 *
 * Advice, not a verdict. {@link safeBranchName} decides what git will
 * accept and this decides what the convention prefers, and the two
 * must not be confused: a name git accepts is workable, and a repo
 * with its own conventions is entitled to it. So this decorates the
 * answer rather than blocking the branch, which is the same shape as
 * every other caution here.
 *
 * The `username/` prefix is checked for shape and not for identity.
 * Who the authenticated user is belongs to whatever hosts the repo,
 * and this layer speaks git; asking a forge would put a network call
 * behind making a branch.
 */
export function namingComplaints(name: string): string[] {
	const said: string[] = [];
	if (!name.includes("/")) {
		said.push(
			"it has no username prefix, and the form is username/what-it-does",
		);
	}
	if (name.length > BRANCH_NAME_BUDGET) {
		said.push(
			`it is ${name.length} characters and the convention keeps them under ${BRANCH_NAME_BUDGET}`,
		);
	}
	if (name !== name.toLowerCase()) {
		said.push("it has capitals, and these are lower case with hyphens");
	}
	if (name.includes("_")) {
		said.push("it separates words with underscores rather than hyphens");
	}
	return said;
}

/**
 * What came of asking for a branch this tree is already on: moved up
 * from the commit it was at, already at the start, or left where it is
 * and why.
 */
export type Repointed =
	| { kind: "moved"; was: string }
	| { kind: "there" }
	| { kind: "refused"; why: string };

/**
 * Move a branch that already exists up to a fresh start, when the move
 * loses nothing; nothing when no branch of that name exists here, so it
 * is made as new.
 *
 * `work tree` on a new branch makes it at the start a recent fetch left,
 * and on 19 November one so made on World sat at a stale main. Asking
 * `work branch` for the same name from `origin/main` then failed on git's
 * "a branch named ... already exists" however fresh the fetch, so the
 * branch could never reach the new base. Asking for a branch by a name
 * the tree is already on, from a start, says where it should start, so
 * it moves there, but only when its head is an ancestor of the start:
 * then every commit on it is in the start too, and moving it is a fast
 * forward. A branch with commits of its own is left alone and the answer
 * says to rebase, which keeps them, and so is one this tree is not on.
 *
 * The start is resolved to a commit once, and the move is a fast-forward
 * merge to that commit, which git refuses unless it is one: a ref that
 * moves after the check cannot carry the branch somewhere unchecked. A
 * fast forward carries staged and unstaged changes along apart, as a
 * checkout does, and refuses, changing nothing, where the start would
 * overwrite one. A name that shadows a remote's branch, or is a ref's
 * full name, is left to the new-branch path, which refuses it. The
 * upstream is set to the start only where the branch had none, as
 * `checkout -b` would have, so a pushed branch keeps tracking its own.
 * `asked` is the start as the caller named it, for the answer, when
 * `start` is its full spelling. A stopped git throws rather than being
 * read as an answer.
 */
export async function repointBranch(
	exec: Exec,
	treePath: string,
	name: string,
	start: string,
	asked: string = start,
): Promise<Repointed | undefined> {
	const safe = safeBranchName(name);
	const from = safeBranchName(start);
	// An unusable name is the new-branch path's to refuse, in its words.
	if (safe === undefined || from === undefined) return undefined;
	if (fullRefRefusal(safe) !== undefined) return undefined;
	const git = async (...args: string[]) => {
		const result = await exec("git", ["-C", treePath, ...args]);
		if (result.code === EXIT_ABORTED) {
			throw new Error(`Stopped while moving ${safe}; it was left where it is.`);
		}
		return result;
	};
	const local = `refs/heads/${safe}`;
	const shadow = await git(
		"rev-parse",
		"--verify",
		"--quiet",
		`refs/remotes/${safe}`,
	);
	if (shadow.code === 0) return undefined;
	const was = await git("rev-parse", "--verify", "--quiet", local);
	if (was.code !== 0) return undefined;
	const current = await git("symbolic-ref", "--quiet", "HEAD");
	if (current.code !== 0 || current.stdout.trim() !== local) {
		return {
			kind: "refused",
			why: `${safe} already exists and this tree is not on it, so it was left where it is. Switch this tree to it first, or name a new branch.`,
		};
	}
	const target = await git(
		"rev-parse",
		"--verify",
		"--quiet",
		`${from}^{commit}`,
	);
	if (target.code !== 0) return undefined;
	const head = was.stdout.trim();
	const commit = target.stdout.trim();
	if (head !== commit) {
		const contained = await git("merge-base", "--is-ancestor", head, commit);
		if (contained.code !== 0) {
			const said = contained.stderr.trim().split("\n")[0]?.trim() ?? "";
			return {
				kind: "refused",
				why:
					said === ""
						? `${safe} already exists here with commits ${asked} lacks, so it was not moved, which would drop them. Rebase it onto ${asked} to bring it up.`
						: `${safe} already exists here, and git could not say whether ${asked} holds its commits (${said}), so it was not moved.`,
			};
		}
		const moved = await git(
			"merge",
			"-q",
			"--ff-only",
			"--no-autostash",
			"--no-verify-signatures",
			commit,
		);
		if (moved.code !== 0) {
			const said = moved.stderr.trim().split("\n").slice(0, 3).join(" ").trim();
			return {
				kind: "refused",
				why: `${safe} could not move up to ${asked}, so it was left where it is.${said === "" ? "" : ` Git said: ${said}`}`,
			};
		}
	}
	if (from.startsWith("refs/remotes/")) {
		const tracked = await git(
			"rev-parse",
			"--verify",
			"--quiet",
			`${safe}@{upstream}`,
		);
		if (tracked.code !== 0) {
			await git("branch", "-q", `--set-upstream-to=${from}`, safe);
		}
	}
	return head === commit ? { kind: "there" } : { kind: "moved", was: head };
}

/** Write to a tree with plain git. */
export function createGitAuthor(deps: { exec: Exec }): WorkAuthor {
	return {
		async stage(treePath, paths) {
			// A bare `git add` stages nothing and reports success, so
			// everything has to be asked for by name.
			const args =
				paths && paths.length > 0 ? ["add", "--", ...paths] : ["add", "--all"];
			await run(
				deps.exec,
				"git",
				["-C", treePath, ...args],
				`Staging work in ${displayPath(treePath)}`,
			);
		},

		async commit(treePath, message) {
			const subject = message.subject?.trim() ?? "";
			if (subject === "") {
				throw new Error(
					"A commit needs a subject: it is the line everybody reads " +
						"when deciding whether to read the rest.",
				);
			}
			const body = message.body?.trim();
			await run(
				deps.exec,
				"git",
				[
					"-C",
					treePath,
					"commit",
					"-m",
					subject,
					// Git knows how a body is separated from a subject.
					// Splicing a blank line in by hand is how that gets
					// done differently in two places.
					...(body ? ["-m", body] : []),
				],
				`Recording work in ${displayPath(treePath)}`,
			);
		},

		async branch(treePath, name, options) {
			const safe = safeBranchName(name);
			if (!safe) {
				throw new Error(
					`Not a usable branch name: ${JSON.stringify(name)}. Names ` +
						"carrying spaces, a leading dash, or git's reserved " +
						"shapes are refused rather than corrected, since " +
						"quietly renaming somebody's branch is worse than " +
						"declining to make it.",
				);
			}
			const fullName = fullRefRefusal(safe);
			if (fullName) throw new Error(fullName);
			let from: string | undefined;
			if (options?.from !== undefined) {
				from = safeBranchName(options.from);
				if (!from) {
					throw new Error(
						`Not a usable start point: ${JSON.stringify(options.from)}.`,
					);
				}
			}
			// Asked for origin/main, git makes a local origin/main beside
			// origin's own, and every later command naming it gets the local
			// one. The tree provider refuses that name too.
			const remote = await deps.exec("git", [
				"-C",
				treePath,
				"rev-parse",
				"--verify",
				"--quiet",
				`refs/remotes/${safe}`,
			]);
			if (remote.code === 0) {
				throw new Error(
					`${safe} is a remote's branch, and a local branch of that name ` +
						"would shadow it. Name the branch to work on, and give " +
						`${safe} as where it starts.`,
				);
			}
			await run(
				deps.exec,
				"git",
				["-C", treePath, "checkout", "-b", safe, ...(from ? [from] : [])],
				`Making ${safe} in ${displayPath(treePath)}`,
			);
		},
	};
}
