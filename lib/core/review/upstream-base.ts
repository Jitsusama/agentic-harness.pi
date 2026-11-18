/**
 * Where a local range's base is read, when the branch it names has
 * fallen behind its upstream.
 *
 * A round asked about `main..topic` read the checkout's own `main`, and
 * a checkout nobody pulls keeps a `main` that is days old. On 18 Nov
 * core.nix's was 10,659 commits behind origin's, so every council on a
 * branch one commit past origin sent each reviewer every commit message
 * and the whole diff since then: prompts of 17 to 42 million characters.
 * The model request timed out with no answer, for all four reviewers
 * at once, round after round. The base a person names is the branch as
 * it stands upstream, so when the local copy is strictly behind its
 * upstream, the upstream's tip is what is read. A local branch with
 * commits of its own, or none upstream, is read as it is.
 */

import type { Exec } from "../exec/index.ts";

/** A base read at its upstream's tip rather than as the local branch. */
export interface UpstreamBase {
	/** The upstream, as git names it, such as origin/main. */
	ref: string;
	/** Its tip, which is what the range is read from. */
	commit: string;
	/** How many commits the local branch is behind it. */
	behind: number;
}

/**
 * The upstream to read `base` at, or nothing when the base is read as
 * named: not a local branch, tracking nothing, level with its upstream,
 * or holding commits its upstream lacks.
 */
export async function upstreamBase(
	exec: Exec,
	root: string,
	base: string,
): Promise<UpstreamBase | undefined> {
	const git = async (...args: string[]): Promise<string | undefined> => {
		const result = await exec("git", ["-C", root, ...args]);
		// Each question has a no for an answer (not a branch, no upstream,
		// not an ancestor), which git says by its exit code.
		return result.code === 0 ? result.stdout.trim() : undefined;
	};
	const local = await git(
		"rev-parse",
		"--verify",
		"--quiet",
		`refs/heads/${base}^{commit}`,
	);
	if (local === undefined) return undefined;
	const ref = await git("rev-parse", "--abbrev-ref", `${base}@{upstream}`);
	if (!ref) return undefined;
	const commit = await git(
		"rev-parse",
		"--verify",
		"--quiet",
		`${ref}^{commit}`,
	);
	if (commit === undefined || commit === local) return undefined;
	const behind = await git("merge-base", "--is-ancestor", local, commit);
	if (behind === undefined) return undefined;
	const count = Number(await git("rev-list", "--count", `${local}..${commit}`));
	return { ref, commit, behind: Number.isFinite(count) ? count : 0 };
}
