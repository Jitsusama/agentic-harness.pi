/**
 * The origin branches a tree cut from a twin holds: the twin's view of
 * origin, held to origin's own list.
 *
 * The view is written as refs in one transaction rather than fetched
 * from the twin: the clone holds every object of the twin already, and a
 * fetch walks every object between the twin's branches and its view of
 * origin to prove it, which on World under load sat past eight minutes
 * on 23 November.
 *
 * The view may be stale: a branch origin deleted, or moved, still reads
 * as origin's in the twin. Carrying the tree on would then leave out
 * commits as though origin had them. So origin's own list, which moves
 * no objects, decides each branch.
 */

/** git run in one tree, as arrive hears it. */
export interface ViewGit {
	run(...args: string[]): Promise<{ code: number; stderr: string }>;
	ok(...args: string[]): Promise<boolean>;
	said(...args: string[]): Promise<string | undefined>;
	/** `git update-ref --stdin` with these lines, as one transaction. */
	updateRefs(
		lines: readonly string[],
	): Promise<{ code: number; stderr: string }>;
}

const REMOTE = "refs/remotes/origin/";

/**
 * Makes the tree's origin branches the twin's view of origin, or, for a
 * twin with none, such as a bare clone, the twin's own branches, which
 * origin's list then keeps only where they match. Answers why not, or
 * nothing.
 */
export async function takeView(
	git: ViewGit,
	twin: string,
): Promise<string | undefined> {
	const inTwin = (under: string) => refsOf(git, under, `--git-dir=${twin}`);
	const viewed = await inTwin(REMOTE);
	const view =
		viewed !== undefined && viewed.size > 0
			? viewed
			: await inTwin("refs/heads/");
	const held = await refsOf(git, REMOTE);
	if (view === undefined || held === undefined) {
		return "git couldn't read the twin's view of its origin.";
	}
	const lines = [
		...[...held.keys()]
			.filter((name) => !view.has(name))
			.map((name) => `delete ${REMOTE}${name}`),
		...[...view].map(([name, commit]) => `update ${REMOTE}${name} ${commit}`),
	];
	if (lines.length === 0) return undefined;
	const set = await git.updateRefs(lines);
	return set.code === 0
		? undefined
		: `git couldn't take the twin's view of its origin: ${set.stderr.trim()}`;
}

/**
 * Makes every origin branch in the tree name what origin's own branch
 * does: one origin lacks goes, one origin moved follows it when its
 * commit is here and goes when not. A branch that goes only costs a
 * later fetch some haves, never a commit. Answers why not, or nothing.
 */
export async function holdToOrigin(git: ViewGit): Promise<string | undefined> {
	const listed = await git.said("ls-remote", "--heads", "origin");
	if (listed === undefined) {
		const asked = await git.run("ls-remote", "--heads", "origin");
		return `git couldn't list origin's branches: ${asked.stderr.trim()}`;
	}
	const theirs = named(listed, "refs/heads/");
	const ours = await refsOf(git, REMOTE);
	const lines: string[] = [];
	for (const [name, commit] of ours ?? []) {
		const there = theirs.get(name);
		if (there === commit) continue;
		const here =
			there !== undefined &&
			(await git.ok("cat-file", "-e", `${there}^{commit}`));
		lines.push(
			here ? `update ${REMOTE}${name} ${there}` : `delete ${REMOTE}${name}`,
		);
	}
	if (lines.length === 0) return undefined;
	const set = await git.updateRefs(lines);
	return set.code === 0
		? undefined
		: `git couldn't drop origin branches origin no longer holds: ${set.stderr.trim()}`;
}

/** The refs under `under`, by name below it, but its HEAD; or nothing. */
async function refsOf(
	git: ViewGit,
	under: string,
	...before: string[]
): Promise<Map<string, string> | undefined> {
	const said = await git.said(
		...before,
		"for-each-ref",
		"--format=%(objectname) %(refname)",
		under,
	);
	if (said === undefined) return undefined;
	const refs = named(said, under);
	refs.delete("HEAD");
	return refs;
}

/** `<commit> <ref>` lines, tab or space apart, by name under `prefix`. */
function named(lines: string, prefix: string): Map<string, string> {
	const refs = new Map<string, string>();
	for (const line of lines.split("\n")) {
		const [commit, ref] = line.trim().split(/\s+/);
		if (commit === undefined || ref === undefined) continue;
		if (!ref.startsWith(prefix)) continue;
		refs.set(ref.slice(prefix.length), commit);
	}
	return refs;
}
