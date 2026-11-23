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
		typeof viewed !== "string" && viewed.size === 0
			? await inTwin("refs/heads/")
			: viewed;
	if (typeof view === "string") {
		return `git couldn't read the twin's view of its origin: ${view}`;
	}
	const held = await refsOf(git, REMOTE);
	if (typeof held === "string") {
		return `git couldn't read its origin branches: ${held}`;
	}
	// A twin ref moved since the clone names a commit not here; it is
	// left out rather than failing the rest.
	const here = await present(git, [...view.values()]);
	if (typeof here === "string") return here;
	const kept = [...view].filter(([, commit]) => here.has(commit));
	const names = new Set(kept.map(([name]) => name));
	return setRefs(
		git,
		[...held.keys()]
			.filter((name) => !names.has(name))
			.map((name) => `${REMOTE}${name}`),
		kept.map(([name, commit]) => [`${REMOTE}${name}`, commit]),
		"take the twin's view of its origin",
	);
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
	if (typeof ours === "string") {
		return `git couldn't read its origin branches: ${ours}`;
	}
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
	if (typeof here === "string") return here;
	const gone: string[] = [];
	const set: [string, string][] = [];
	for (const [name, commit] of moved) {
		const there = theirs?.get(name);
		if (there !== undefined && here.has(there)) {
			set.push([`${REMOTE}${name}`, there]);
			continue;
		}
		gone.push(`${REMOTE}${name}`);
		if (theirs === undefined || there !== undefined) {
			set.push([`${ASIDE}${name}`, commit]);
		}
	}
	return setRefs(git, gone, set, "hold its origin branches to origin");
}

/**
 * The commits of `commits` this tree holds, asked of git at once; or why
 * git couldn't say.
 */
async function present(
	git: ViewGit,
	commits: readonly string[],
): Promise<Set<string> | string> {
	if (commits.length === 0) return new Set();
	const checked = await git.fed(
		commits.map((commit) => `${commit}^{commit}`),
		"cat-file",
		"--batch-check=%(objectname) %(objecttype)",
	);
	if (checked.code !== 0) {
		return `git couldn't say which commits are here: ${checked.stderr.trim()}`;
	}
	const found = new Set<string>();
	for (const line of checked.stdout.split("\n")) {
		const [commit, type] = line.trim().split(" ");
		if (commit !== undefined && type === "commit") found.add(commit);
	}
	return found;
}

/**
 * The refs `gone` deleted, then the refs `set` written, each as one
 * update-ref transaction: deleting first frees a name such as `x` that a
 * ref `x/y` written after needs. Answers why not, or nothing.
 */
async function setRefs(
	git: ViewGit,
	gone: readonly string[],
	set: readonly (readonly [string, string])[],
	doing: string,
): Promise<string | undefined> {
	for (const lines of [
		gone.map((ref) => `delete ${ref}`),
		set.map(([ref, commit]) => `update ${ref} ${commit}`),
	]) {
		if (lines.length === 0) continue;
		const done = await git.fed(lines, "update-ref", "--stdin");
		if (done.code !== 0) return `git couldn't ${doing}: ${done.stderr.trim()}`;
	}
	return undefined;
}

/**
 * The refs under `under`, by name below it, but its HEAD; or git's word
 * on why it couldn't read them.
 */
async function refsOf(
	git: ViewGit,
	under: string,
	...before: string[]
): Promise<Map<string, string> | string> {
	const read = await git.run(
		...before,
		"for-each-ref",
		"--format=%(objectname) %(refname)",
		under,
	);
	if (read.code !== 0) return read.stderr.trim() || `git exited ${read.code}`;
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
