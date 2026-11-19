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

import type { Exec } from "../exec/index.ts";
import { fullRefRefusal, safeBranchName } from "./author.ts";

/** Where origin's own branches are tracked; trunk must be one of them. */
const ORIGIN_REFS = "refs/remotes/origin/";

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
 * Whether another branch is stacked on this one, naming it as the
 * parent the work tool's stacks record (stacks.ts). Deleting the parent
 * would leave the child's stack pointing at nothing, so it stays until
 * the child is restacked onto trunk or goes itself.
 */
async function stackedOn(
	exec: Exec,
	checkout: string,
	name: string,
): Promise<boolean> {
	const parents = await exec("git", [
		"-C",
		checkout,
		"config",
		"--get-regexp",
		"^branch\\..*\\.workparent$",
	]);
	// Exit 1 is git saying no key matched, so nothing is stacked on it.
	if (parents.code !== 0) return false;
	return parents.stdout
		.split("\n")
		.some((line) => line.slice(line.indexOf(" ") + 1).trim() === name);
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
	if (name === undefined || fullRefRefusal(name)) return false;
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
	if (await stackedOn(exec, checkout, name)) return false;
	// -D rather than -d: -d judges by the branch's upstream or by HEAD,
	// neither of which is trunk once a pull request's branch is deleted.
	// Trunk has every commit, checked just above; git still refuses a
	// branch some checkout has out, and takes its config section with it.
	// A commit can't land on the branch between the check and here through
	// a checkout, since git would then refuse; only a hand-made ref write
	// could, which nothing in this tool does.
	return (await git("branch", "-D", name)).code === 0;
}
