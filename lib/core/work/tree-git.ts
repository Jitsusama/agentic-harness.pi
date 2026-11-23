/**
 * Asking git about one tree, as the commits, rebases, stacks and
 * carries do before they act.
 */

import type { Exec } from "../exec/index.ts";

/**
 * Read one git value, scoped to the tree, or undefined when git fails
 * or says nothing.
 *
 * Every call is scoped with `-C`, because the exec seam has no working
 * directory of its own: an unscoped git call runs wherever the process
 * happens to sit and answers confidently about the wrong repository.
 */
export async function ask(
	exec: Exec,
	treePath: string,
	args: readonly string[],
): Promise<string | undefined> {
	const result = await exec("git", ["-C", treePath, ...args]);
	if (result.code !== 0) return undefined;
	const said = result.stdout.trim();
	return said === "" ? undefined : said;
}

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
export async function remoteTrunk(
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

/** Paths git reports as unmerged. */
export async function conflictedIn(
	exec: Exec,
	treePath: string,
): Promise<readonly string[]> {
	const said = await ask(exec, treePath, [
		"diff",
		"--name-only",
		"--diff-filter=U",
	]);
	return said === undefined ? [] : said.split("\n").filter((one) => one !== "");
}
