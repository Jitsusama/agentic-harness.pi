/**
 * Letting go of a branch trunk already has.
 *
 * Taking a tree back took its directory and left its branch, along with
 * the `[branch]` section a push wrote into the checkout's config. Agents
 * cut thousands: core.nix's checkout held 5,734 local branches and 518 KB
 * of config, which every git command there read, the host's presence
 * publish among them. A branch whose commits are all on the remote's
 * trunk holds nothing anyone can lose, so it goes when its tree does.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../exec/index.ts";
import { fullRefRefusal, safeBranchName } from "./author.ts";

/** Where origin's own branches are tracked; trunk must be one of them. */
const ORIGIN_REFS = "refs/remotes/origin/";

/** Where a checkout's own branches live. */
const BRANCH_REFS = "refs/heads/";

/**
 * How many branches one `git branch -D` is handed, so the first sweep of
 * a checkout holding hundreds stays well inside an argument list.
 */
const DELETE_BATCH = 100;

/**
 * The remote's trunk as a ref, or nothing when the checkout has no
 * remote trunk to judge by. A local trunk is not asked, since a commit
 * on it may never have been pushed.
 *
 * origin/HEAD is taken only when it names one of origin's own branches
 * and that branch is there: one left dangling by a rename, or pointed at
 * a local branch by hand, falls back to origin/main rather than judging
 * by something that is not the remote's trunk.
 */
async function remoteTrunk(
	exec: Exec,
	checkout: string,
): Promise<string | undefined> {
	const git = (...args: string[]) => exec("git", ["-C", checkout, ...args]);
	const there = async (ref: string) =>
		(await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)).code ===
		0;
	const head = await git("symbolic-ref", "--quiet", `${ORIGIN_REFS}HEAD`);
	const named = head.code === 0 ? head.stdout.trim() : "";
	if (
		named.startsWith(ORIGIN_REFS) &&
		named !== `${ORIGIN_REFS}HEAD` &&
		(await there(named))
	)
		return named;
	const main = `${ORIGIN_REFS}main`;
	return (await there(main)) ? main : undefined;
}

/**
 * The branches others are stacked on, named as the parent the work
 * tool's stacks record (stacks.ts), or nothing when the config can't be
 * read. Deleting a parent would leave the child's stack pointing at
 * nothing, so it stays until the child is restacked onto trunk or goes
 * itself.
 */
async function stackParents(
	exec: Exec,
	checkout: string,
): Promise<Set<string> | undefined> {
	const parents = await exec("git", [
		"-C",
		checkout,
		"config",
		"--get-regexp",
		"^branch\\..*\\.workparent$",
	]);
	// Exit 1 is git saying no key matched, so nothing is stacked on any.
	if (parents.code === 1) return new Set();
	if (parents.code !== 0) return undefined;
	return new Set(
		parents.stdout
			.split("\n")
			.filter((line) => line.includes(" "))
			.map((line) => line.slice(line.indexOf(" ") + 1).trim()),
	);
}

/** Whether git would take `name` as a branch this code may delete. */
function deletable(name: string): boolean {
	return safeBranchName(name) === name && fullRefRefusal(name) === undefined;
}

/**
 * Delete `branch` and its config section from `checkout` when every
 * commit on it is on the remote's trunk, answering whether it went.
 *
 * Kept, answering false, when: the name is not one git would take; it
 * is trunk's own name; the checkout has no remote trunk; the branch has
 * a commit trunk lacks, pushed or not, as a squash-merged branch does;
 * another branch is stacked on it; or git refuses, as it does for a
 * branch any checkout has out. Trunk is read as last fetched, with no
 * fetch, so release never waits on the network; a merge not fetched yet
 * keeps the branch, and nothing here comes back for it.
 */
export async function dropMergedBranch(
	exec: Exec,
	checkout: string,
	branch: string,
): Promise<boolean> {
	const name = safeBranchName(branch);
	if (name === undefined || !deletable(name)) return false;
	const trunk = await remoteTrunk(exec, checkout);
	if (trunk === undefined || trunk.endsWith(`/${name}`)) return false;
	const git = (...args: string[]) => exec("git", ["-C", checkout, ...args]);
	const tip = await git(
		"rev-parse",
		"--verify",
		"--quiet",
		`refs/heads/${name}^{commit}`,
	);
	if (tip.code !== 0) return false;
	const merged = await git(
		"merge-base",
		"--is-ancestor",
		tip.stdout.trim(),
		trunk,
	);
	if (merged.code !== 0) return false;
	const parents = await stackParents(exec, checkout);
	if (parents === undefined || parents.has(name)) return false;
	// -D rather than -d: -d judges by the branch's upstream or by HEAD,
	// neither of which is trunk once a pull request's branch is deleted.
	// Trunk has every commit, checked just above; git still refuses a
	// branch some checkout has out, and takes its config section with it.
	// A commit can't land on the branch between the check and here through
	// a checkout, since git would then refuse; only a hand-made ref write
	// could, which nothing in this tool does.
	return (await git("branch", "-D", name)).code === 0;
}

/**
 * Delete every branch in `checkout` that the remote's trunk holds and
 * nobody has moved since `settledBefore`, in milliseconds since the
 * epoch, with its config section, answering how many went.
 *
 * This is for a branch whose tree went before its pull request merged,
 * which release kept since trunk lacked it then. A branch is kept by
 * every rule {@link dropMergedBranch} keeps one by, and also when its
 * reflog moved within the settling time, since a session may have made
 * it moments ago to cut a tree at, or when it has no reflog to say when
 * it last moved, as in a reftable checkout. All of trunk's merged
 * branches are listed at once and handed to git in batches, so the cost
 * stays a few git runs whatever the count: core.nix's checkout held
 * 4,762 merged ones on 19 November.
 */
export async function dropSettledMergedBranches(
	exec: Exec,
	checkout: string,
	settledBefore: number,
): Promise<number> {
	const trunk = await remoteTrunk(exec, checkout);
	if (trunk === undefined) return 0;
	const git = (...args: string[]) => exec("git", ["-C", checkout, ...args]);
	const merged = await git(
		"for-each-ref",
		`--merged=${trunk}`,
		"--format=%(refname)",
		BRANCH_REFS,
	);
	const common = await git(
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	);
	const parents = await stackParents(exec, checkout);
	if (merged.code !== 0 || common.code !== 0 || parents === undefined) {
		return 0;
	}
	const logs = join(common.stdout.trim(), "logs");
	const going = merged.stdout
		.split("\n")
		.filter((ref) => ref.startsWith(BRANCH_REFS))
		.filter((ref) => settled(join(logs, ref), settledBefore))
		.map((ref) => ref.slice(BRANCH_REFS.length))
		.filter(
			(name) =>
				deletable(name) && !trunk.endsWith(`/${name}`) && !parents.has(name),
		);
	if (going.length === 0) return 0;
	for (let at = 0; at < going.length; at += DELETE_BATCH) {
		// Git deletes each it can and refuses, saying why, any some checkout
		// has out; what is left is counted below, not read from its words.
		await git("branch", "-D", ...going.slice(at, at + DELETE_BATCH));
	}
	const left = await git("for-each-ref", "--format=%(refname)", BRANCH_REFS);
	if (left.code !== 0) return 0;
	const standing = new Set(left.stdout.split("\n"));
	return going.filter((name) => !standing.has(`${BRANCH_REFS}${name}`)).length;
}

/**
 * Whether a branch's reflog, at `log`, last moved before `before`. One
 * with no reflog can't say, so it is never settled.
 */
function settled(log: string, before: number): boolean {
	try {
		return statSync(log).mtimeMs < before;
	} catch {
		// No reflog, or none git keeps as a file: nothing says when the
		// branch last moved, so it is kept.
		return false;
	}
}
