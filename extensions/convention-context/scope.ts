/**
 * Work-tree scope check for the resident binding block. The
 * block should ride only where PR, commit, issue and Slack
 * authoring actually happens, which is anywhere inside a git
 * work tree. This deliberately uses `git rev-parse
 * --is-inside-work-tree` rather than a cwd-local `.git` check:
 * most authoring happens deep inside worktrees (for example
 * `~/world/trees/<tree>/src`) where the git root is several
 * levels up and a local `.git` probe would miss it.
 */

/** Minimal shape of pi's exec, narrowed to what the check needs. */
type ExecLike = (
	command: string,
	args: string[],
	options?: { cwd?: string },
) => Promise<{ stdout: string; code: number }>;

/**
 * Return true when `cwd` is inside a git work tree. Any failure
 * (not a repo, git missing, the .git directory itself) yields
 * false, so the block is omitted rather than injected on a guess.
 */
export async function isInsideWorkTree(
	exec: ExecLike,
	cwd: string,
): Promise<boolean> {
	try {
		const result = await exec("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd,
		});
		return result.code === 0 && result.stdout.trim() === "true";
	} catch {
		// git absent or the spawn failed: treat as outside a work
		// tree and omit the block rather than inject on a guess.
		return false;
	}
}
