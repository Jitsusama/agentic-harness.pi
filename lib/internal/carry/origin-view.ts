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
 * the tree's next fetch send none and take all of World again. Those
 * branches are then fetched from origin at once, with the twin's commits
 * as haves, since a carry onward counts only refs/remotes as on origin:
 * a tree with no origin/main would bundle all of its trunk.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec, ExecResult } from "../../core/exec/index.ts";

/** git run in one tree, as arrive hears it. */
export interface ViewGit {
	run(...args: string[]): Promise<ExecResult>;
	ok(...args: string[]): Promise<boolean>;
	said(...args: string[]): Promise<string | undefined>;
	/** git with these lines as its standard input. */
	fed(lines: readonly string[], ...args: string[]): Promise<ExecResult>;
	/**
	 * git stopped once it has run `seconds`, for a call to a remote that
	 * may never answer: ssh and git:// have no bound of git's own.
	 */
	within(seconds: number): Pick<ViewGit, "run" | "fed">;
}

/** How holding a tree to origin went: refused with why, or unsure why. */
export interface Held {
	/** Why the tree can't stand, so it goes. */
	readonly why?: string;
	/** Why it stands claiming less of origin than origin holds. */
	readonly unsure?: string;
}

const REMOTE = "refs/remotes/origin/";

/** Where a branch's twin commit waits as a have, claiming nothing. */
export const ASIDE = "refs/carry/twin/";

/**
 * A listing of origin that stops rather than waits on a link sending
 * under a kilobyte a second for half a minute.
 */
const BOUNDED = ["-c", "http.lowSpeedLimit=1024", "-c", "http.lowSpeedTime=30"];

/** How long origin has to list its branches, over any transport. */
const LISTING = 60;

/** How long origin has to send the branches it moved past the twin. */
const FETCHING = 900;

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
 * origin it can't show yet keeps its haves. Those set aside then come
 * from origin, where it answers. Answers why not, or why the tree claims
 * less of origin than origin holds, or nothing.
 */
export async function holdToOrigin(git: ViewGit): Promise<Held> {
	const ours = await refsOf(git, REMOTE);
	if (typeof ours === "string") {
		return { why: `git couldn't read its origin branches: ${ours}` };
	}
	const listed = await git
		.within(LISTING)
		.run(...BOUNDED, "ls-remote", "--heads", "origin");
	const theirs =
		listed.code === 0 ? named(listed.stdout, "refs/heads/") : undefined;
	const moved = [...ours].filter(
		([name, commit]) => theirs?.get(name) !== commit,
	);
	const here = await present(
		git,
		moved.flatMap(([name]) => theirs?.get(name) ?? []),
	);
	if (typeof here === "string") return { why: here };
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
	const why = await setRefs(
		git,
		gone,
		set,
		"hold its origin branches to origin",
	);
	if (why !== undefined) return { why };
	if (theirs === undefined) {
		return {
			unsure: `Origin couldn't be listed, so its branches wait under ${ASIDE}: ${saidOf(listed)}`,
		};
	}
	return takeAside(
		git,
		set.flatMap(([ref]) =>
			ref.startsWith(ASIDE) ? [ref.slice(ASIDE.length)] : [],
		),
	);
}

/**
 * The branches `names`, set aside, fetched from origin into the tree's
 * origin branches, the twin's commits under `ASIDE` sent as haves, and
 * those then dropped. Answers why they wait aside still, or nothing.
 */
async function takeAside(
	git: ViewGit,
	names: readonly string[],
): Promise<Held> {
	if (names.length === 0) return {};
	const fetched = await git.within(FETCHING).fed(
		names.map((name) => `+refs/heads/${name}:${REMOTE}${name}`),
		...BOUNDED,
		"fetch",
		"-q",
		"--no-tags",
		"--no-write-fetch-head",
		"--stdin",
		"origin",
	);
	if (fetched.code !== 0) {
		return {
			unsure: `Origin's branches past the twin didn't come, so they wait under ${ASIDE}: ${saidOf(fetched)}`,
		};
	}
	// Left behind, they would only keep commits from gc.
	const dropped = await setRefs(
		git,
		names.map((name) => `${ASIDE}${name}`),
		[],
		"drop the twin's commits origin's own now cover",
	);
	return dropped === undefined ? {} : { unsure: dropped };
}

/** What git said of why it failed. */
function saidOf(result: ExecResult): string {
	return result.stderr.trim() || `git exited ${result.code}`;
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

/**
 * git as `sh` runs it in the tree at `path`: its input from `file`, and,
 * where `seconds` is over 0, its whole process group stopped once it has
 * run that long, with `file.stopped` left to say so. The watch runs
 * apart from what exec hears, so it never holds exec's pipes open.
 */
const THROUGH = `p=$1 f=$2 t=$3
shift 3
set -m
git -C "$p" "$@" <"$f" &
g=$!
set +m
w=
if [ "$t" -gt 0 ]; then
	(
		trap 'kill "$s" 2>/dev/null; exit 0' TERM
		sleep "$t" &
		s=$!
		wait "$s" && : >"$f.stopped" && kill -TERM -"$g"
	) >/dev/null 2>&1 &
	w=$!
fi
wait "$g"
c=$?
if [ -n "$w" ]; then kill "$w" 2>/dev/null; fi
exit "$c"`;

/** git run in the tree at `path`, through `exec`. */
export function gitIn(exec: Exec, path: string): ViewGit {
	const run = (...args: string[]) => exec("git", ["-C", path, ...args]);
	const through = async (
		seconds: number,
		lines: readonly string[],
		args: readonly string[],
	): Promise<ExecResult> => {
		// Exec gives no stdin, so the lines go through a file sh reads in,
		// kept in the tree's own .git, which goes with it if it's refused.
		let folder: string | undefined;
		try {
			folder = mkdtempSync(join(path, ".git", "carry-in-"));
			const file = join(folder, "in");
			writeFileSync(file, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
			const done = await exec("sh", [
				"-c",
				THROUGH,
				"sh",
				path,
				file,
				String(seconds),
				...args,
			]);
			return existsSync(`${file}.stopped`)
				? {
						...done,
						code: done.code === 0 ? 1 : done.code,
						stderr:
							`git was stopped after ${seconds} seconds. ${done.stderr}`.trim(),
					}
				: done;
		} catch (error) {
			// Exec answers rather than throws, and so does this.
			return { code: 1, stdout: "", stderr: String(error) };
		} finally {
			if (folder !== undefined) {
				rmSync(folder, { recursive: true, force: true });
			}
		}
	};
	return {
		run,
		ok: async (...args) => (await run(...args)).code === 0,
		said: async (...args) => {
			const result = await run(...args);
			return result.code === 0 ? result.stdout.trim() : undefined;
		},
		fed: (lines, ...args) => through(0, lines, args),
		within: (seconds) => ({
			run: (...args) => through(seconds, [], args),
			fed: (lines, ...args) => through(seconds, lines, args),
		}),
	};
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
