/**
 * A branch started from a remote's branch starts from where it is now.
 *
 * `work branch` with `from: origin/main` used to hand git the name as it
 * stood, and a remote-tracking ref is only as fresh as the last fetch.
 * One session cut two branches on 22 October from an `origin/main` a merge
 * behind: each time its `git fetch` ran in the same parallel batch as the
 * branch call, so git made the branch first and the fetch landed after.
 * The answer said only which branch the tree was on, so nothing showed it
 * until the work was built on the wrong base and fixed by hand.
 *
 * Asking for a remote's branch is asking for that branch as the remote
 * holds it, so the one branch named is fetched first. Only that branch,
 * which keeps this cheap in a monorepo whose full fetch costs minutes. A
 * fetch that fails leaves the start point as it was and says so, since
 * offline work is still work; and the answer names the commit the branch
 * starts at either way, so a stale base can be seen rather than inferred.
 */

import type { Exec } from "@jitsusama/agentic-harness.core/exec";

/**
 * How long fetching one branch may take before the branch is made from
 * what is already here. A narrow fetch of one branch normally answers in
 * a second or two; a minute is a network that is not answering.
 */
export const FETCH_MS = 60_000;

/** The remote and branch a start point names, when it names one. */
export function remoteBranchOf(
	from: string,
	remotes: readonly string[],
): { remote: string; branch: string } | undefined {
	// The longest remote first, so a remote named `origin/mirror` is not
	// mistaken for `origin` with a branch called `mirror/...`.
	const byLength = [...remotes].sort((a, b) => b.length - a.length);
	const remote = byLength.find((name) => from.startsWith(`${name}/`));
	if (remote === undefined) return undefined;
	const branch = from.slice(remote.length + 1);
	return branch === "" ? undefined : { remote, branch };
}

/**
 * Fetch the remote branch a start point names, if it names one. Answers
 * a sentence to pass on when the fetch could not be made, and nothing
 * when it was, or when the start point is local and there was nothing to
 * fetch.
 */
export async function refreshStart(
	exec: Exec,
	treePath: string,
	from: string,
): Promise<string | undefined> {
	const listed = await exec("git", ["-C", treePath, "remote"]);
	if (listed.code !== 0) return undefined;
	const named = remoteBranchOf(
		from,
		listed.stdout.split("\n").filter((line) => line.trim() !== ""),
	);
	if (named === undefined) return undefined;
	// The refspec is spelled out, so the tracking ref is written even in a
	// checkout whose configured fetch is narrower than this branch.
	const fetched = await exec("git", [
		"-C",
		treePath,
		"fetch",
		"-q",
		named.remote,
		`+refs/heads/${named.branch}:refs/remotes/${named.remote}/${named.branch}`,
	]);
	if (fetched.code === 0) return undefined;
	const why = fetched.stderr.trim().split("\n")[0] || `exit ${fetched.code}`;
	return `Could not fetch ${from} just now (${why}), so it starts where ${from} stood at the last fetch.`;
}
