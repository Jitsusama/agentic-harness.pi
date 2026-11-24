/**
 * How the work tool's fetches of one checkout are made, where its
 * owner says how: from what a prefetch already brought, or behind a
 * command that takes the fetch's turn.
 *
 * World's store on optimus is fetched by one program, which writes
 * every branch of origin under `refs/prefetch/remotes/origin/` and
 * fetches nothing during a call. The work tool fetched it as well: a
 * tree, a branch, a rebase or a sync fetched main, and a snapshot of
 * a short id fetched every one of origin's 17,781 branches. At 17:47
 * on 24 November two snapshots' fetches ran at once outside every
 * turn, each 5.4 GB, holding memory past the overload cut and holding
 * up another session's push (1OGSE7 [89ac6ac4]).
 *
 * So a checkout the `work` section names as prefetched has a fetch of
 * one of a remote's branches answered by moving its tracking ref to
 * the prefetched commit, never back past where it stands, and a fetch
 * of no named ref answered by the prefetch having brought every
 * branch already. A fetch it can't answer, as of a commit by its id,
 * runs behind the section's `through`, for World a check that no call
 * is on and the push turn that takes one World fetch at a time. A
 * checkout the section doesn't name fetches as it always did: git's
 * own maintenance writes `refs/prefetch` in other repositories too,
 * where the prefetch is no promise of anything, so it is never
 * assumed.
 *
 * The tracking ref is moved with a reflog line saying it was a fetch,
 * so a start that trusts a recent fetch (`fresh-start.ts`) trusts this
 * one too: the prefetch runs every few minutes, so a rebase onto main
 * starts from a main at most that old, and lands through a gate that
 * reads main as it is then.
 */

import type { Exec, ExecResult } from "../exec/index.ts";

/** How one checkout's fetches are made. */
export interface FetchRule {
	/**
	 * Shell text a fetch runs behind, with git and its words as `"$@"`;
	 * left out, it runs as it is.
	 */
	readonly through?: string;
	/**
	 * Whether something else fetches every branch of the checkout's
	 * remotes under `refs/prefetch/remotes/`, so the work tool need not.
	 */
	readonly prefetched?: boolean;
}

/** The rule for the checkout whose git folder is `gitDir`, if any. */
export type FetchRules = (gitDir: string) => Promise<FetchRule | undefined>;

/** The `work` section's fetch rules, keyed by git folder, and what was wrong. */
export interface ParsedFetchRules {
	readonly fetches: Readonly<Record<string, FetchRule>>;
	readonly problems: readonly string[];
}

/**
 * The fetch rules a `work` section gives, as
 * `{"fetches": {"<git folder>": {"through": "...", "prefetched": true}}}`;
 * an entry that isn't one is reported and left out.
 */
export function parseWorkFetches(section: unknown): ParsedFetchRules {
	if (section === undefined) return { fetches: {}, problems: [] };
	if (!isRecord(section)) {
		return { fetches: {}, problems: ["work: the section is not an object."] };
	}
	const listed = section.fetches;
	if (listed === undefined) return { fetches: {}, problems: [] };
	if (!isRecord(listed)) {
		return {
			fetches: {},
			problems: ["work.fetches: not an object of git folders."],
		};
	}
	const fetches: Record<string, FetchRule> = {};
	const problems: string[] = [];
	for (const [folder, value] of Object.entries(listed)) {
		const rule = ruleOf(value);
		if (typeof rule === "string") {
			problems.push(`work.fetches.${folder}: ${rule}`);
		} else if (!folder.startsWith("/")) {
			problems.push(`work.fetches.${folder}: not an absolute git folder.`);
		} else {
			fetches[withoutTrailingSlash(folder)] = rule;
		}
	}
	return { fetches, problems };
}

function ruleOf(value: unknown): FetchRule | string {
	if (!isRecord(value)) return "not an object.";
	const { through, prefetched } = value;
	if (
		through !== undefined &&
		(typeof through !== "string" || !through.trim())
	) {
		return "through is not shell text.";
	}
	if (prefetched !== undefined && typeof prefetched !== "boolean") {
		return "prefetched is not true or false.";
	}
	return {
		...(typeof through === "string" ? { through } : {}),
		...(prefetched === true ? { prefetched } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutTrailingSlash(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** A git fetch as its words name it. */
export interface GitFetch {
	/** The folder git runs in, as `-C` names it. */
	readonly folder: string;
	/** The remote fetched from, when one is named. */
	readonly remote: string | undefined;
	/** The refs it names, as git's refspecs. */
	readonly refspecs: readonly string[];
}

/** git's options before its command that take the next word. */
const VALUED_GLOBALS = new Set(["-C", "-c", "--git-dir", "--work-tree"]);

/** A commit's id, short or full, as a fetch might name one. */
const COMMIT_ID = /^[0-9a-f]{4,64}$/;

/**
 * The fetch `args` asks git for, when they ask for one in a folder
 * named with `-C`; anything else is none.
 */
export function gitFetchOf(args: readonly string[]): GitFetch | undefined {
	let folder: string | undefined;
	let at = 0;
	while (at < args.length && args[at]?.startsWith("-")) {
		const word = args[at] ?? "";
		if (VALUED_GLOBALS.has(word)) {
			if (word === "-C") folder = args[at + 1];
			at += 2;
		} else {
			at += 1;
		}
	}
	if (args[at] !== "fetch" || folder === undefined) return undefined;
	const named = args.slice(at + 1).filter((word) => !word.startsWith("-"));
	const [remote, ...refspecs] = named;
	return { folder, remote, refspecs };
}

/** The branch a refspec fetches and the ref it writes, when it names a branch. */
function branchOf(
	refspec: string,
	remote: string,
): { branch: string; tracking: string } | undefined {
	const [source = "", written] = refspec.replace(/^\+/, "").split(":");
	if (source === "" || COMMIT_ID.test(source) || source.includes("*")) {
		return undefined;
	}
	const branch = source.replace(/^refs\/heads\//, "");
	if (branch.startsWith("refs/")) return undefined;
	return { branch, tracking: written || `refs/remotes/${remote}/${branch}` };
}

/**
 * An exec whose fetches follow `rules`: one a checkout's prefetch can
 * answer is answered from it, one behind a `through` runs behind it,
 * and every other command runs through `exec` as it was. `through`
 * runs a fetch behind shell text; left out, it runs it as
 * `bash -c '<through> "$@"' work-fetch git …` through `exec`.
 */
export function fetchingBy(
	exec: Exec,
	rules: FetchRules,
	behind: (rule: FetchRule, args: readonly string[]) => Promise<ExecResult> = (
		rule,
		args,
	) =>
		exec("bash", ["-c", `${rule.through} "$@"`, "work-fetch", "git", ...args]),
): Exec {
	return async (command, args) => {
		const fetch = command === "git" ? gitFetchOf(args) : undefined;
		if (fetch === undefined) return exec(command, args);
		const rule = await ruleFor(exec, rules, fetch.folder);
		if (rule?.prefetched) {
			const answered = await fromPrefetch(exec, fetch);
			if (answered) return answered;
		}
		return rule?.through ? behind(rule, args) : exec(command, args);
	};
}

/** The rule for the checkout `folder` lies in, read by its git folder. */
async function ruleFor(
	exec: Exec,
	rules: FetchRules,
	folder: string,
): Promise<FetchRule | undefined> {
	const found = await exec("git", [
		"-C",
		folder,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (found.code !== 0) return undefined;
	return rules(withoutTrailingSlash(found.stdout.trim()));
}

/** What a fetch answered from the prefetch says, for git's quiet. */
const ANSWERED: ExecResult = { code: 0, stdout: "", stderr: "" };

/**
 * The fetch answered from the prefetch, or nothing when it can't be:
 * it names a commit by its id, or a branch nothing prefetched.
 */
async function fromPrefetch(
	exec: Exec,
	fetch: GitFetch,
): Promise<ExecResult | undefined> {
	const git = (...args: string[]) => exec("git", ["-C", fetch.folder, ...args]);
	const remote = fetch.remote;
	if (remote === undefined) return undefined;
	// Every branch is prefetched, so a fetch naming none has nothing to bring.
	if (fetch.refspecs.length === 0) return ANSWERED;
	const moves: { tracking: string; to: string }[] = [];
	for (const refspec of fetch.refspecs) {
		const named = branchOf(refspec, remote);
		if (named === undefined) return undefined;
		const prefetched = await git(
			"rev-parse",
			"--verify",
			"--quiet",
			`refs/prefetch/remotes/${remote}/${named.branch}^{commit}`,
		);
		if (prefetched.code !== 0) return undefined;
		moves.push({ tracking: named.tracking, to: prefetched.stdout.trim() });
	}
	for (const { tracking, to } of moves) {
		await moveForward(git, tracking, to);
	}
	return ANSWERED;
}

/**
 * `tracking` moved to `to`, unless it already holds it: a fetch made
 * since the prefetch is newer, and moving back would lose it.
 */
async function moveForward(
	git: (...args: string[]) => Promise<ExecResult>,
	tracking: string,
	to: string,
): Promise<void> {
	const now = await git("rev-parse", "--verify", "--quiet", tracking);
	const was = now.code === 0 ? now.stdout.trim() : "";
	if (was === to) return;
	if (was !== "") {
		const holds = await git("merge-base", "--is-ancestor", to, was);
		if (holds.code === 0) return;
	}
	// Said as a fetch, so a start that trusts a recent fetch trusts this.
	await git(
		"update-ref",
		"-m",
		"fetch: from the prefetch",
		tracking,
		to,
		...(was === "" ? [] : [was]),
	);
}
