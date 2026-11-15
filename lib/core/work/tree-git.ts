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
