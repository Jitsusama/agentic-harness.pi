/**
 * A tree cut from a twin learns origin's branches from the twin, which
 * may be stale: a branch origin deleted, or moved, still reads as
 * origin's there. Carrying the tree on would then leave out commits as
 * though origin had them. So each origin branch the tree holds is held
 * to origin's own list, which moves no objects.
 */

/** git run in one tree, as arrive hears it. */
export interface ViewGit {
	run(...args: string[]): Promise<{ code: number; stderr: string }>;
	ok(...args: string[]): Promise<boolean>;
	said(...args: string[]): Promise<string | undefined>;
}

const REMOTE = "refs/remotes/origin/";

/** At most this many refs go to one git call, to stay under argv limits. */
const AT_ONCE = 200;

/**
 * Makes every `refs/remotes/origin/*` in the tree name what origin's
 * own branch does: one origin lacks goes, one origin moved follows it
 * when its commit is here and goes when not. A ref that goes only costs
 * a later fetch some haves, never a commit. Answers why not, or nothing.
 */
export async function holdToOrigin(git: ViewGit): Promise<string | undefined> {
	const listed = await git.said("ls-remote", "--heads", "origin");
	if (listed === undefined) {
		const asked = await git.run("ls-remote", "--heads", "origin");
		return `git couldn't list origin's branches: ${asked.stderr.trim()}`;
	}
	const theirs = branches(listed, "refs/heads/");
	const held = await git.said(
		"for-each-ref",
		"--format=%(objectname) %(refname)",
		REMOTE,
	);
	const ours = branches(held ?? "", REMOTE);
	const gone: string[] = [];
	for (const [name, commit] of ours) {
		const there = theirs.get(name);
		if (there === commit) continue;
		if (
			there !== undefined &&
			(await git.ok("cat-file", "-e", `${there}^{commit}`))
		) {
			const moved = await git.run("update-ref", `${REMOTE}${name}`, there);
			if (moved.code === 0) continue;
		}
		gone.push(`origin/${name}`);
	}
	for (let at = 0; at < gone.length; at += AT_ONCE) {
		const dropped = await git.run(
			"branch",
			"-q",
			"-r",
			"-D",
			...gone.slice(at, at + AT_ONCE),
		);
		if (dropped.code !== 0) {
			return `git couldn't drop origin branches origin no longer holds: ${dropped.stderr.trim()}`;
		}
	}
	return undefined;
}

/** `<commit> <ref>` lines, tab or space apart, by name under `prefix`. */
function branches(lines: string, prefix: string): Map<string, string> {
	const named = new Map<string, string>();
	for (const line of lines.split("\n")) {
		const [commit, ref] = line.trim().split(/\s+/);
		if (commit === undefined || ref === undefined) continue;
		if (!ref.startsWith(prefix)) continue;
		named.set(ref.slice(prefix.length), commit);
	}
	return named;
}
