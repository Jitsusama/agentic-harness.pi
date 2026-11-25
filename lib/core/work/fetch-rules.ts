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
 * one of a remote's branches answered by moving its tracking ref
 * forward to the prefetched commit, and a fetch of no named ref
 * answered by the prefetch having brought every branch already. A
 * fetch it can't answer runs behind the section's `through`, for World
 * a check that no call is on and the push turn that takes one World
 * fetch at a time: one of a commit by its id, of a remote nothing
 * prefetched, with an option the answer can't honour, writing a ref
 * outside the remote's own, or of a branch the prefetch doesn't hold
 * or that moved off the line its tracking ref is on, as a force push
 * moves it. A move git refuses runs the fetch too, so an answer never
 * claims a ref moved that didn't. A checkout the section doesn't name
 * fetches as it always did: git's own maintenance writes
 * `refs/prefetch` in other repositories too, where the prefetch is no
 * promise of anything, so it is never assumed.
 *
 * A tracking ref already ahead of the prefetch stays where it is,
 * since a fetch made since is newer. The move's reflog line doesn't
 * say it was a fetch, so a start that trusts a recent fetch
 * (`fresh-start.ts`) asks again, and is answered from the prefetch
 * again: the prefetch's age is not known here, and a fetch's would
 * claim it was made now. The prefetch runs every few minutes but not
 * during a call, so a start can be that far behind origin; it lands
 * through a gate that reads main as it is then.
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

/** What the shell a command runs behind calls itself, as `$0`. */
const BEHIND_NAME = "work-fetch";

/**
 * The words bash takes to run `command` with `args` behind `through`:
 * the rule's shell text with the command as `"$@"`, so a rule ending
 * in `exec turn --` runs the command inside its turn, and a rule that
 * exits first, as one does during a call, runs nothing. The command
 * and its words travel as bash's positional parameters, never as shell
 * text. The rule's text is taken without trailing space, since a
 * newline there would leave `"$@"` on a line of its own and the rule
 * running with no command.
 */
export function behindThrough(
	through: string,
	command: string,
	args: readonly string[],
): string[] {
	return ["-c", `${through.trimEnd()} "$@"`, BEHIND_NAME, command, ...args];
}

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
	/** The options it was given after `fetch`, as written. */
	readonly options: readonly string[];
}

/**
 * The options a fetch answered from the prefetch can honour, since
 * they change only what git says or writes beside the refs: any other,
 * as `--prune`, `--depth` or `--dry-run`, asks for what an answer
 * doesn't do, so that fetch is made.
 */
const ANSWERABLE_OPTIONS = new Set([
	"-q",
	"--quiet",
	"--no-tags",
	"--no-write-fetch-head",
]);

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
	const words = args.slice(at + 1);
	const named = words.filter((word) => !word.startsWith("-"));
	const options = words.filter((word) => word.startsWith("-"));
	const [remote, ...refspecs] = named;
	return { folder, remote, refspecs, options };
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
	const tracking = written || `refs/remotes/${remote}/${branch}`;
	// Only the remote's own refs: a fetch writing a branch of ours, or
	// any other ref, is git's to refuse or allow, so it is made.
	if (!tracking.startsWith(`refs/remotes/${remote}/`)) return undefined;
	return { branch, tracking };
}

/**
 * An exec whose fetches follow `rules`: one a checkout's prefetch can
 * answer is answered from it, one behind a `through` runs behind it,
 * and every other command runs through `exec` as it was. `behind`
 * runs a fetch behind its rule's `through`, as the queue's exec does
 * after the guard (`queued-exec.ts`).
 */
export function fetchingBy(
	exec: Exec,
	rules: FetchRules,
	behind: (rule: FetchRule, args: readonly string[]) => Promise<ExecResult>,
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

type Git = (...args: string[]) => Promise<ExecResult>;

/** A tracking ref's move to the prefetched commit. */
interface Move {
	readonly tracking: string;
	readonly to: string;
	/** What it holds now, or "" when it holds nothing. */
	readonly was: string;
}

/**
 * The fetch answered from the prefetch, or nothing when it can't be
 * (the module's header says when).
 */
async function fromPrefetch(
	exec: Exec,
	fetch: GitFetch,
): Promise<ExecResult | undefined> {
	const git: Git = (...args) => exec("git", ["-C", fetch.folder, ...args]);
	const remote = fetch.remote;
	if (remote === undefined) return undefined;
	if (!fetch.options.every((option) => ANSWERABLE_OPTIONS.has(option))) {
		return undefined;
	}
	if (!(await prefetchKept(git, remote))) return undefined;
	// Every branch is prefetched, so a fetch naming none has nothing to bring.
	if (fetch.refspecs.length === 0) return ANSWERED;
	const moves: Move[] = [];
	for (const refspec of fetch.refspecs) {
		const named = branchOf(refspec, remote);
		if (named === undefined) return undefined;
		const move = await moveOf(git, remote, named.branch, named.tracking);
		if (move === undefined) return undefined;
		if (move !== "held") moves.push(move);
	}
	for (const move of moves) {
		if (!(await moved(git, move))) return undefined;
	}
	return ANSWERED;
}

/** Whether anything is prefetched of `remote`'s branches at all. */
async function prefetchKept(git: Git, remote: string): Promise<boolean> {
	const found = await git(
		"for-each-ref",
		"--count=1",
		"--format=%(refname)",
		`refs/prefetch/remotes/${remote}/`,
	);
	return found.code === 0 && found.stdout.trim() !== "";
}

/**
 * How `tracking` comes to hold `branch` as prefetched: a move forward,
 * `held` when it is there already or ahead (a fetch made since is
 * newer, and moving back would lose it), or nothing when the prefetch
 * lacks the branch or it left the line the ref is on, which only a
 * fetch can settle.
 */
async function moveOf(
	git: Git,
	remote: string,
	branch: string,
	tracking: string,
): Promise<Move | "held" | undefined> {
	const prefetched = await git(
		"rev-parse",
		"--verify",
		"--quiet",
		`refs/prefetch/remotes/${remote}/${branch}^{commit}`,
	);
	if (prefetched.code !== 0) return undefined;
	const to = prefetched.stdout.trim();
	const now = await git("rev-parse", "--verify", "--quiet", tracking);
	const was = now.code === 0 ? now.stdout.trim() : "";
	if (was === "") return { tracking, to, was };
	if (was === to) return "held";
	if ((await git("merge-base", "--is-ancestor", was, to)).code === 0) {
		return { tracking, to, was };
	}
	if ((await git("merge-base", "--is-ancestor", to, was)).code === 0) {
		return "held";
	}
	return undefined;
}

/** Whether git made `move`, only from what the ref held when it was read. */
async function moved(git: Git, move: Move): Promise<boolean> {
	const made = await git(
		"update-ref",
		"-m",
		"prefetch: moved to the prefetched commit",
		move.tracking,
		move.to,
		// An empty old value makes git refuse a ref that has come to exist.
		move.was,
	);
	return made.code === 0;
}
