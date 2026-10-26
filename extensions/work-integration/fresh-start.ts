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
 * fetch that fails leaves the start point as it was and says why, since
 * offline work is still work; and the answer names the commit the branch
 * starts at either way, so a stale base can be seen rather than inferred.
 *
 * Refreshing the tracking ref does not weaken a later `push replace`: its
 * lease compares against the tracking ref of the branch being pushed, and
 * where that is the branch fetched here, the new branch starts at exactly
 * the commit the lease then holds, which is the work it was built on.
 */

import {
	EXIT_ABORTED,
	EXIT_TIMED_OUT,
	type Exec,
} from "../../lib/core/exec/index.ts";
import { safeBranchName } from "../../lib/core/work/index.ts";

/**
 * How long fetching one branch may take before the branch is made from
 * what is already here. A narrow fetch of one branch normally answers in
 * a second or two; three minutes leaves room for a big repository far
 * behind, and past it the network is not answering.
 */
export const FETCH_MS = 3 * 60_000;

/** How much of git's own reason is passed on, since a remote writes it. */
const REASON_CHARS = 200;

/** A remote's branch, as a start point names one. */
export interface RemoteBranch {
	remote: string;
	branch: string;
}

/**
 * The remote and branch a start point names, when it names one. The
 * short form `origin/main` and the full `refs/remotes/origin/main` (or
 * `remotes/origin/main`) name the same thing. A start point core would
 * refuse names nothing, so a call that will be refused fetches nothing.
 */
export function remoteBranchOf(
	from: string,
	remotes: readonly string[],
): RemoteBranch | undefined {
	const safe = safeBranchName(from);
	if (safe === undefined) return undefined;
	const bare = safe.replace(/^(refs\/)?remotes\//, "");
	// The longest remote first, so a remote named `origin/mirror` is not
	// mistaken for `origin` with a branch called `mirror/...`.
	const byLength = [...remotes].sort((a, b) => b.length - a.length);
	const remote = byLength.find((name) => bare.startsWith(`${name}/`));
	if (remote === undefined) return undefined;
	const branch = bare.slice(remote.length + 1);
	return branch === "" ? undefined : { remote, branch };
}

/** What making a branch from a start point should be handed. */
export interface FreshStart {
	/**
	 * The start point to give git. A remote's branch is spelled out in
	 * full, since a local branch or tag called `origin/main` makes the
	 * short name ambiguous and git refuses it.
	 */
	start: string;
	/** A sentence to pass on when the start could not be refreshed. */
	stale?: string;
}

/**
 * Fetch the remote branch a start point names, if it names one, and say
 * what to start from. Throws only when the call was stopped, since a
 * branch made after somebody pressed escape is not what they asked for.
 */
export async function refreshStart(
	exec: Exec,
	treePath: string,
	from: string,
	signal?: AbortSignal,
): Promise<FreshStart> {
	const listed = await exec("git", ["-C", treePath, "remote"]);
	const named =
		listed.code === 0
			? remoteBranchOf(
					from,
					listed.stdout.split("\n").filter((line) => line.trim() !== ""),
				)
			: undefined;
	if (named === undefined) return { start: from };
	const tracking = `refs/remotes/${named.remote}/${named.branch}`;
	if (named.branch === "HEAD") {
		// The remote's default branch as recorded here, which is a pointer
		// to another tracking ref rather than a branch the remote can send.
		return {
			start: tracking,
			stale: `${from} is the remote's default branch as recorded at the last fetch, so it was not fetched now; name the branch itself to have it fetched first.`,
		};
	}
	// The refspec is spelled out, so the tracking ref is written even in a
	// checkout whose configured fetch is narrower than this branch.
	const fetched = await exec("git", [
		"-C",
		treePath,
		"fetch",
		"-q",
		named.remote,
		`+refs/heads/${named.branch}:${tracking}`,
	]);
	if (fetched.code === EXIT_ABORTED || signal?.aborted) {
		throw new Error(`Stopped while fetching ${from}; no branch was made.`);
	}
	if (fetched.code === 0) return { start: tracking };
	return { start: tracking, stale: fetchFailure(from, fetched) };
}

/** Why a fetch could not be made, said so the next step is plain. */
function fetchFailure(
	from: string,
	fetched: { code: number; stderr: string },
): string {
	if (fetched.code === EXIT_TIMED_OUT) {
		return `Fetching ${from} took longer than ${FETCH_MS / 60_000} minutes, so it starts where ${from} stood at the last fetch. Fetch it on its own, in the background, then branch again.`;
	}
	const said = fetched.stderr.trim().split("\n")[0]?.trim() ?? "";
	const why =
		said === ""
			? `exit ${fetched.code}`
			: said.length > REASON_CHARS
				? `${said.slice(0, REASON_CHARS)}…`
				: said;
	return `Could not fetch ${from} just now (${why}), so it starts where ${from} stood at the last fetch.`;
}
