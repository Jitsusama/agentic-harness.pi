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

/**
 * The remote's trunk as a ref, or nothing when the checkout has no
 * remote trunk to judge by. A local trunk is not asked, since a commit
 * on it may never have been pushed.
 */
async function remoteTrunk(
	exec: Exec,
	checkout: string,
): Promise<string | undefined> {
	const head = await exec("git", [
		"-C",
		checkout,
		"symbolic-ref",
		"--quiet",
		"refs/remotes/origin/HEAD",
	]);
	if (head.code === 0 && head.stdout.trim() !== "") return head.stdout.trim();
	const main = await exec("git", [
		"-C",
		checkout,
		"rev-parse",
		"--verify",
		"--quiet",
		"refs/remotes/origin/main",
	]);
	return main.code === 0 ? "refs/remotes/origin/main" : undefined;
}

/**
 * Delete `branch` and its config section from `checkout` when every
 * commit on it is on the remote's trunk, answering whether it went.
 *
 * Kept, answering false, when: the name is not one git would take; it
 * is trunk's own name; the checkout has no remote trunk; the branch has
 * a commit trunk lacks, pushed or not; or git refuses, as it does for a
 * branch any checkout has out. Trunk is read as last fetched, so a merge
 * not fetched yet keeps the branch, for a later sweep to take.
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
	// -D rather than -d: -d judges by the branch's upstream or by HEAD,
	// neither of which is trunk once a pull request's branch is deleted.
	// Trunk has every commit, checked just above; git still refuses a
	// branch some checkout has out, and takes its config section with it.
	return (await git("branch", "-D", name)).code === 0;
}
