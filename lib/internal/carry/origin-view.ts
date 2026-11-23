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
 * The view may be stale. A branch origin deleted, or force-pushed, still
 * reads as origin's in the twin, and a carry counts everything under
 * refs/remotes as on origin, so carrying the tree on would leave out
 * commits. So origin's own list, which moves no objects, decides each
 * branch. A branch origin moved past what is here can't be told from one
 * force-pushed, so it leaves refs/remotes but keeps the twin's commit
 * under `refs/carry/twin/`: a fetch sends every ref's commit as a have,
 * and a twin merely behind origin, the usual case, would otherwise make
 * the tree's next fetch send none and take all of World again.
 */

/** git run in one tree, as arrive hears it. */
export interface ViewGit {
	run(
		...args: string[]
	): Promise<{ code: number; stdout: string; stderr: string }>;
	ok(...args: string[]): Promise<boolean>;
	said(...args: string[]): Promise<string | undefined>;
	/** git with these lines as its standard input. */
	fed(
		lines: readonly string[],
		...args: string[]
	): Promise<{ code: number; stdout: string; stderr: string }>;
}

const REMOTE = "refs/remotes/origin/";

/** Where a branch's twin commit waits as a have, claiming nothing. */
export const ASIDE = "refs/carry/twin/";

/**
 * A listing of origin that stops rather than waits on a link sending
 * under a kilobyte a second for half a minute.
 */
const BOUNDED = ["-c", "http.lowSpeedLimit=1024", "-c", "http.lowSpeedTime=30"];

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
	return setRefs(git, lines, "take the twin's view of its origin");
}

/**
 * Makes every origin branch in the tree name what origin's own branch
 * does. One origin lacks goes. One origin moved follows it when its
 * commit is here, and otherwise steps aside under `ASIDE`, as does every
 * branch when origin can't be listed, so the tree claims nothing of
 * origin it can't show yet keeps its haves. Answers why not, or nothing.
 */
export async function holdToOrigin(git: ViewGit): Promise<string | undefined> {
	const ours = await refsOf(git, REMOTE);
	if (ours === undefined) return "git couldn't read its origin branches.";
	const listed = await git.run(...BOUNDED, "ls-remote", "--heads", "origin");
	const theirs =
		listed.code === 0 ? named(listed.stdout, "refs/heads/") : undefined;
	const moved = [...ours].filter(
		([name, commit]) => theirs?.get(name) !== commit,
	);
	const here = await present(
		git,
		moved.flatMap(([name]) => theirs?.get(name) ?? []),
	);
	const lines = moved.flatMap(([name, commit]) => {
		const there = theirs?.get(name);
		if (theirs !== undefined && there === undefined) {
			return [`delete ${REMOTE}${name}`];
		}
		if (there !== undefined && here.has(there)) {
			return [`update ${REMOTE}${name} ${there}`];
		}
		return [`delete ${REMOTE}${name}`, `update ${ASIDE}${name} ${commit}`];
	});
	return setRefs(git, lines, "hold its origin branches to origin");
}

/** The commits of `commits` this tree holds, asked of git at once. */
async function present(
	git: ViewGit,
	commits: readonly string[],
): Promise<Set<string>> {
	if (commits.length === 0) return new Set();
	const checked = await git.fed(
		commits.map((commit) => `${commit}^{commit}`),
		"cat-file",
		"--batch-check=%(objectname) %(objecttype)",
	);
	const found = new Set<string>();
	for (const line of checked.stdout.split("\n")) {
		const [commit, type] = line.trim().split(" ");
		if (commit !== undefined && type === "commit") found.add(commit);
	}
	return found;
}

/** The lines applied as one update-ref transaction; why not, or nothing. */
async function setRefs(
	git: ViewGit,
	lines: readonly string[],
	doing: string,
): Promise<string | undefined> {
	if (lines.length === 0) return undefined;
	const set = await git.fed(lines, "update-ref", "--stdin");
	return set.code === 0
		? undefined
		: `git couldn't ${doing}: ${set.stderr.trim()}`;
}

/** The refs under `under`, by name below it, but its HEAD; or nothing. */
async function refsOf(
	git: ViewGit,
	under: string,
	...before: string[]
): Promise<Map<string, string> | undefined> {
	const read = await git.run(
		...before,
		"for-each-ref",
		"--format=%(objectname) %(refname)",
		under,
	);
	if (read.code !== 0) return undefined;
	const refs = named(read.stdout, under);
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
