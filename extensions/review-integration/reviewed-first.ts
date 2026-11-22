/**
 * Holding a change back from people until our own council has read it.
 *
 * Joel, 17 November: "we must run our own reviews on everything before
 * asking for reviews from others". So a change opened for review, moved
 * to ready, or put to reviewers needs a finished council whose reviewers
 * read one of its commits; one read before a last fix still counts,
 * since what it found was fixed on top of it. A draft goes up without
 * one, since nobody is asked to look at a draft, unless reviewers are
 * named with it.
 *
 * The commits are read from the checkout: a range from the change's
 * base to its head, each as the remote has it when it does, since what
 * goes up is the pushed branch. A change's own commits leave out those
 * another pushed branch holds without its head: a branch cut from
 * reviewed work, or left by a squash merge, would otherwise pass on
 * that work's council with none of its own read. A branch above it in
 * a stack holds its head, so its commits stay its own, and the change's
 * own branch on any remote is never another's. Where only such shared
 * commits were read, the refusal names the branches that hold them,
 * since a restack or a deleted copy lets the change through without
 * another council. Only branches the checkout has as remote refs are
 * seen: a council records the head it read, not its range, so once
 * reviewed work's branch is pruned nothing tells its commits from the
 * change's. One that can't be read is said as that, not as a
 * missing council, so nobody pays for a council that would be refused
 * the same way.
 *
 * A rebase gives every commit a new id, so a council read before it
 * would count for nothing, and a clean rebase would cost a round that
 * reads what was read already. So the branch's earlier heads, as its
 * reflogs in the checkout recall them, count too. A council that read
 * one of them lends itself to the change when that head is its
 * branch's own work, as the change's own commits are judged, and its
 * change, replayed by git from where it left the base onto where the
 * change leaves it now, gives byte for byte the tree of the change's
 * head or of one of its own commits below it, as a fix after a council
 * keeps it. Only the head the council read lends, never the commits
 * under it: after a restack those are the old copies of a lower
 * branch's, which no pushed branch holds any more. A rebase that had to
 * settle a conflict, or brought anything else along, gives another tree
 * and needs a round of its own; so the replay runs in a scratch repo
 * that reads no settings or attributes, and no merge driver can settle
 * a conflict for it. Nor does any commit work from elsewhere brought
 * the branch to lend, or anything under one: where it was made or
 * copied, and every reset, fast-forward, `branch -f` or `checkout -B`
 * since. That is work it was cut from or took in, which after a restack
 * or a rebase no pushed branch may hold any more. Only a commit, a
 * cherry-pick, a revert, a merge that made a commit and a rebase that
 * replayed something are the branch's own; a subject git may write one
 * day counts as brought. So the branch's reflog in this checkout must
 * still reach back to its making or copying. Only the last
 * EARLIER_HEADS of each reflog are asked about, and a checkout that
 * never held the branch before its rebase remembers none.
 *
 * A council counts wherever in the realm it ran: this machine's ledger
 * is asked first, and only when it holds none, each other machine's
 * mirrored under runs-from, a folder a node holding the files of that
 * machine's review/runs directly (a link to such a folder counts too).
 * The mirror is filled from outside the harness and only read here, so
 * a round run on the Mac while optimus's memory holds councils back
 * still lets the change through, and no ledger takes in another
 * machine's rounds. A refusal names the mirrors it asked, and says so
 * when they couldn't be listed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Exec } from "../../lib/core/exec/index.ts";
import { createRunStore } from "../../lib/core/review/index.ts";
import { mirroredRunsDir, runDir } from "./engine.ts";

/** How many of a change's commits are asked about, newest first. */
const COMMITS_ASKED = 500;

/**
 * How many other branches one `rev-list` leaves out. A clone with tens
 * of thousands of remote branches would otherwise pass them all on one
 * command line, past what the kernel takes.
 */
const REFS_A_CALL = 500;

/** How many of a branch's earlier heads, newest first, each reflog is asked for. */
const EARLIER_HEADS = 30;

/** How git's reflog says a branch was made, in its oldest entry. */
const MADE = "branch: Created from ";

/**
 * How git's reflog says a branch's own work moved it: a commit of any
 * kind, a cherry-pick, a revert, a merge that made a commit. Anything
 * else (a reset, a fast-forward, `branch -f`, `checkout -B`, a fetch,
 * or a subject git may write one day) brought work from elsewhere.
 */
const OWN_WORK = [
	/^commit( \([a-z -]+\))?: /,
	/^cherry-pick: /,
	/^revert: /,
	/^(merge|pull)( [^:]*)?: Merge made by /,
];

/**
 * How git's reflog says a rebase finished, naming the commit it went
 * onto: its own work only when it replayed some, so the head isn't that
 * commit itself.
 */
const REBASED =
	/^(rebase|rebase -i|pull( [^:]*)?) \(finish\): \S+ onto ([0-9a-f]{40})$/;

/** How git's reflog says a branch was renamed, moving nothing. */
const RENAMED = "Branch: renamed ";

/** How git's reflog says a branch was copied, its entries older than this the source's. */
const COPIED = "Branch: copied ";

/** How many of the branches holding a change's reviewed commits a refusal names. */
const HOLDERS_NAMED = 3;

/** A full commit id, as git prints one a line. */
const COMMIT_ID = /^[0-9a-f]{40}$/;

/** Whether a finished council in `repo` read one of `commits`. */
export type Witnesses = (
	repo: string,
	commits: ReadonlySet<string>,
) => Promise<boolean>;

/** The ledgers one judgement asks, and what to say of them on a refusal. */
interface Ledgers {
	readonly witnessed: Witnesses;
	/** Which mirrors were asked, or why they couldn't be, as a sentence. */
	readonly said: () => Promise<string>;
}

/** The mirrors under runs-from, or why they couldn't be listed. */
interface Mirrors {
	readonly ledgers: readonly string[];
	readonly trouble?: string;
}

/**
 * This machine's ledger, then, only on a miss, each mirrored one. A
 * council run on another machine of the realm is still our own review:
 * equilibrius runs rounds while optimus's memory holds councils back,
 * and its ledger is mirrored here rather than merged into ours. The
 * mirrors are listed once for the judgement, however often it asks.
 *
 * Any writer in the realm is trusted, as this machine's own ledger
 * already is: whoever can write runs-from can write runs.
 */
function realmLedgers(): Ledgers {
	let listing: Promise<Mirrors> | undefined;
	const mirrors = () => {
		listing ??= mirroredLedgers();
		return listing;
	};
	return {
		witnessed: async (repo, commits) => {
			const here = await createRunStore(runDir()).witnessed(repo, commits);
			if (here !== undefined) return true;
			for (const ledger of (await mirrors()).ledgers) {
				const read = await createRunStore(ledger).witnessed(repo, commits);
				if (read !== undefined) return true;
			}
			return false;
		},
		said: async () => {
			const { ledgers, trouble } = await mirrors();
			if (trouble !== undefined) return ` ${trouble}`;
			if (ledgers.length === 0) return "";
			const nodes = ledgers.map((ledger) => basename(ledger)).join(", ");
			return ` Asked this machine's ledger and those mirrored from ${nodes}.`;
		},
	};
}

/**
 * Each machine's mirrored ledger, a folder or a link to one a node, in
 * name order. A stray file beside them is left out.
 */
async function mirroredLedgers(): Promise<Mirrors> {
	const root = mirroredRunsDir();
	let nodes: Awaited<ReturnType<typeof readNodes>>;
	try {
		nodes = await readNodes(root);
	} catch (error) {
		// No mirror on this machine is ordinary: only the local ledger is
		// asked, as before mirrors existed. Any other failure is said.
		if (hasCode(error, "ENOENT")) return { ledgers: [] };
		return {
			ledgers: [],
			trouble: `The councils mirrored under ${root} couldn't be listed (${error instanceof Error ? error.message : String(error)}), so only this machine's ledger was asked.`,
		};
	}
	const ledgers: string[] = [];
	for (const node of nodes) {
		const path = join(root, node.name);
		if (node.isDirectory() || (node.isSymbolicLink() && (await isFolder(path))))
			ledgers.push(path);
	}
	return { ledgers: ledgers.sort() };
}

/** The entries under runs-from, with their types. */
function readNodes(root: string) {
	return readdir(root, { withFileTypes: true });
}

/** Whether `path` leads to a folder, following links. */
async function isFolder(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		// A dangling link leads nowhere, so it holds no ledger to ask.
		return false;
	}
}

/** Whether `error` carries the errno `code`. */
function hasCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

let judge: Witnesses | undefined;

/** Judge councils by `witnesses` instead of the ledgers, for a test. */
export function witnessCouncilsWith(witnesses: Witnesses | undefined): void {
	judge = witnesses;
}

/** The ledgers a judgement asks: a test's stand-in, or the realm's. */
function ledgersNow(): Ledgers {
	return judge === undefined
		? realmLedgers()
		: { witnessed: judge, said: async () => "" };
}

/** What a change is, for asking whether a council read it. */
export interface ChangeCommits {
	/** The repo's key, as the change's rounds are held under it. */
	readonly repo: string;
	/** The checkout to read its commits from. */
	readonly checkout: string;
	/** What it merges into, as a branch. */
	readonly base: string;
	/** Its head, as a branch or a commit. */
	readonly head: string;
	/** A commit known to be its head, when the backend says. */
	readonly headCommit?: string;
}

/**
 * The change's own commits, and those in its range another pushed
 * branch holds without its head, with those branches' names; or why
 * they couldn't be read.
 */
type Read =
	| {
			commits: string[];
			shared: string[];
			holders: string[];
			/** The base and head as read, each as the remote has it when it does. */
			base: string;
			head: string;
	  }
	| { unread: string };

/**
 * Why `doing` must wait for a council of ours, or nothing when one has
 * read a commit of the change.
 */
export async function councilFirst(
	exec: Exec,
	change: ChangeCommits,
	doing: string,
): Promise<string | undefined> {
	const { witnessed, said } = ledgersNow();
	const read = await commitsOf(exec, change);
	const commits = new Set("commits" in read ? read.commits : []);
	if (change.headCommit) commits.add(change.headCommit);
	if (await witnessed(change.repo, commits)) return undefined;
	const range = `${change.base}..${change.head}`;
	if ("unread" in read) {
		return `${range} isn't ${doing}: ${read.unread}, so whether our own council read it can't be told (Joel's rule: our own review before anyone else's). Push the branch, or pass repo naming a checkout that has it, then ask again.`;
	}
	if (await rebasedReviewed(exec, change, read, witnessed)) return undefined;
	if (
		read.shared.length > 0 &&
		(await witnessed(change.repo, new Set(read.shared)))
	) {
		const named = read.holders.slice(0, HOLDERS_NAMED).join(", ");
		const more = read.holders.length > HOLDERS_NAMED ? " and others" : "";
		return `${range} isn't ${doing} yet: the council of ours that read it read commits ${named}${more} also hold without its head, so they count as that work's, not this change's (Joel's rule: our own review before anyone else's). If those are this change before its last fix, as a branch above it in a stack or an old copy, restack them onto its head or delete them, push, and ask again. Otherwise run review_ask council on this change at its head.`;
	}
	return `No council of ours has read ${range} yet, so it isn't ${doing} (Joel's rule: our own review before anyone else's). (A rebase keeps a council when the head it read is among the last ${EARLIER_HEADS} this checkout's reflogs recall, the branch's reflog here reaches back to its making, that head is its own work above wherever it was made, reset or fast-forwarded to, and git replays it onto the new base cleanly to this change's tree, or to one of its commits below a fix.) Run review_ask council on it at its head (base the change below it, for a change in a stack), or review_ask stack over a stack already proposed, as drafts if need be (with an intent saying why, if it refuses another), check each finding against the source, fix and push what holds, then ask again. A draft can go up first: propose with draft true and no reviewers.${await said()}`;
}

/** The change's commits, newest first. */
async function commitsOf(exec: Exec, change: ChangeCommits): Promise<Read> {
	// A name is somebody's string, and git reads one opening with a dash
	// as an option however it is placed.
	for (const name of [change.base, change.head]) {
		if (name.startsWith("-")) return { unread: `"${name}" isn't a ref` };
	}
	const git = (...args: string[]) =>
		exec("git", ["-C", change.checkout, ...args]);
	const pushed = async (name: string) => {
		const remote = `origin/${name}`;
		const known = await git(
			"rev-parse",
			"--verify",
			"--quiet",
			"--end-of-options",
			`${remote}^{commit}`,
		);
		return known.code === 0 ? remote : name;
	};
	const base = await pushed(change.base);
	const head = change.headCommit ?? (await pushed(change.head));
	const range = await rangeOf(git, base, head, change.head);
	return range
		? { ...range, base, head }
		: { unread: `${base}..${head} can't be read in ${change.checkout}` };
}

/**
 * The commits from `base` to `head` that are `branch`'s own, and those
 * another pushed branch holds without `head`, with those branches'
 * names; nothing when they can't be read.
 */
async function rangeOf(
	git: (...args: string[]) => ReturnType<Exec>,
	base: string,
	head: string,
	branch: string,
): Promise<
	{ commits: string[]; shared: string[]; holders: string[] } | undefined
> {
	const list = async (...without: string[]) => {
		const listed = await git(
			"rev-list",
			`--max-count=${COMMITS_ASKED}`,
			"--end-of-options",
			`${base}..${head}`,
			...without.map((sha) => `^${sha}`),
		);
		return listed.code === 0 ? commitIds(listed.stdout) : undefined;
	};
	const all = await list();
	if (all === undefined) return undefined;
	const others = await othersHolding(git, head, branch, all);
	if (others === undefined) return undefined;
	// A commit is the change's own when no batch of other branches holds
	// it, so each batch's answer narrows what the last left.
	const own = new Set(all);
	for (let at = 0; at < others.commits.length; at += REFS_A_CALL) {
		const kept = await list(...others.commits.slice(at, at + REFS_A_CALL));
		if (kept === undefined) return undefined;
		const stays = new Set(kept);
		for (const sha of own) if (!stays.has(sha)) own.delete(sha);
	}
	return {
		commits: all.filter((sha) => own.has(sha)),
		shared: all.filter((sha) => !own.has(sha)),
		holders: others.names,
	};
}

/**
 * Whether a council read an earlier head of the change's branch, its
 * own work then, whose change replayed onto the base the change sits on
 * now gives the tree of the change's head or of one of its own commits,
 * so that only a clean rebase, and fixes after it, stand between them.
 */
async function rebasedReviewed(
	exec: Exec,
	change: ChangeCommits,
	read: { base: string; head: string; commits: readonly string[] },
	witnesses: Witnesses,
): Promise<boolean> {
	const git = (...args: string[]) =>
		exec("git", ["-C", change.checkout, ...args]);
	const tip = await git(
		"rev-parse",
		"--verify",
		"--quiet",
		"--end-of-options",
		`${read.head}^{commit}`,
	);
	if (tip.code !== 0) return false;
	const now = tip.stdout.trim();
	const history = await historyOf(git, change.head);
	if (history === undefined) return false;
	// A pushed head the branch here never held was made elsewhere, so only
	// those it held, further back than its own heads are asked, recall more.
	const pushed = (await pushedHeads(git, change.head)).filter((sha) =>
		history.held.has(sha),
	);
	const earlier = [...new Set([...history.heads, ...pushed])].filter(
		(sha) => sha !== now,
	);
	// One look at the ledger before any replay, since most changes
	// refused were never read at all.
	if (earlier.length === 0 || !(await witnesses(change.repo, new Set(earlier))))
		return false;
	const onto = await forkOf(git, read.base, now);
	const trees = await ownTrees(git, read.base, now, read.commits);
	if (onto === undefined || trees === undefined) return false;
	const scratch = await scratchRepo(exec, git);
	if (scratch === undefined) return false;
	try {
		for (const head of earlier) {
			if (!(await witnesses(change.repo, new Set([head])))) continue;
			if (await atOrBelowAny(git, head, history.arrivals)) continue;
			const tree = await replayed(git, scratch, read.base, head, onto);
			if (tree === undefined || !trees.has(tree)) continue;
			if (await ownWherever(git, read.base, head, earlier, change.head))
				return true;
		}
		return false;
	} finally {
		scratch.remove();
	}
}

/**
 * What `branch`'s local reflog in the checkout says of it: its last
 * EARLIER_HEADS heads, every head it held since its making, and every
 * commit work from elsewhere brought it to, its making among them. A copy's entries older than the copy are
 * its source's, so they are left out and the copy is an arrival. Nothing
 * when the reflog no longer reaches back to the branch's making or
 * copying, since what came before can't be told, or there is no such
 * branch.
 */
async function historyOf(
	git: (...args: string[]) => ReturnType<Exec>,
	branch: string,
): Promise<
	{ heads: string[]; held: Set<string>; arrivals: string[] } | undefined
> {
	const logged = await git(
		"log",
		"--walk-reflogs",
		"--format=%H %gs",
		"--end-of-options",
		`refs/heads/${branch}`,
		"--",
	);
	if (logged.code !== 0) return undefined;
	const heads: string[] = [];
	const held = new Set<string>();
	const arrivals: string[] = [];
	for (const line of logged.stdout.split("\n")) {
		const [commit = "", ...words] = line.split(" ");
		if (!COMMIT_ID.test(commit)) continue;
		const said = words.join(" ");
		held.add(commit);
		if (heads.length < EARLIER_HEADS && !heads.includes(commit))
			heads.push(commit);
		if (said.startsWith(MADE) || said.startsWith(COPIED)) {
			arrivals.push(commit);
			return { heads, held, arrivals };
		}
		if (!movedByItself(commit, said)) arrivals.push(commit);
	}
	return undefined;
}

/**
 * Whether a reflog entry saying `said`, leaving the branch at `commit`,
 * is the branch's own work or a rename, rather than work brought from
 * elsewhere.
 */
function movedByItself(commit: string, said: string): boolean {
	if (said.startsWith(RENAMED)) return true;
	if (OWN_WORK.some((own) => own.test(said))) return true;
	const rebased = REBASED.exec(said);
	return rebased !== null && rebased[3] !== commit;
}

/**
 * Whether `head` is one of `arrivals` or under one: work the branch was
 * cut from or brought in, never its own, whoever's council read it.
 */
async function atOrBelowAny(
	git: (...args: string[]) => ReturnType<Exec>,
	head: string,
	arrivals: readonly string[],
): Promise<boolean> {
	for (const arrival of arrivals) {
		const under = await git("merge-base", "--is-ancestor", head, arrival);
		// 1 says it isn't; anything else can't be told from it being so.
		if (under.code !== 1) return true;
	}
	return false;
}

/**
 * Whether `commit` was `branch`'s own work at each of its earlier
 * `heads` that holds it. Judged at itself alone, a branch pointing just
 * there would read as one above it, so reviewed work a branch was cut
 * from would pass for the branch's own.
 */
async function ownWherever(
	git: (...args: string[]) => ReturnType<Exec>,
	base: string,
	commit: string,
	heads: readonly string[],
	branch: string,
): Promise<boolean> {
	let held = false;
	for (const head of heads) {
		const range = await rangeOf(git, base, head, branch);
		if (range === undefined) return false;
		if (range.shared.includes(commit)) return false;
		if (range.commits.includes(commit)) held = true;
	}
	return held;
}

/**
 * The trees of `head`'s own commits from `base`, `own` naming them;
 * nothing when they can't be read.
 */
async function ownTrees(
	git: (...args: string[]) => ReturnType<Exec>,
	base: string,
	head: string,
	own: readonly string[],
): Promise<Set<string> | undefined> {
	const logged = await git(
		"log",
		"--format=%H %T",
		`--max-count=${COMMITS_ASKED}`,
		"--end-of-options",
		`${base}..${head}`,
		"--",
	);
	if (logged.code !== 0) return undefined;
	const mine = new Set(own);
	const trees = new Set<string>();
	for (const [commit, tree] of logged.stdout
		.split("\n")
		.map((line) => line.split(" ")))
		if (commit && tree && mine.has(commit) && COMMIT_ID.test(tree))
			trees.add(tree);
	return trees;
}

/**
 * Where a replay runs: a bare repo of its own that reads the checkout's
 * objects and writes its own, with no settings and no attributes from
 * anywhere, so no merge driver a setting or an attributes file names
 * (`merge.default`, a `merge=union`, in the change, the checkout, the
 * person's files or the system's) can settle a conflict and call it
 * clean. The command runs `git` under `env`, which sets what it reads
 * and unsets what would point it elsewhere.
 */
interface Scratch {
	readonly run: (...args: string[]) => ReturnType<Exec>;
	readonly remove: () => void;
}

/** A scratch repo for replays, or nothing when one can't be made. */
async function scratchRepo(
	exec: Exec,
	git: (...args: string[]) => ReturnType<Exec>,
): Promise<Scratch | undefined> {
	const objects = await git(
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		"objects",
	);
	const empty = await git("hash-object", "-t", "tree", "/dev/null");
	const tree = empty.stdout.trim();
	if (objects.code !== 0 || empty.code !== 0 || !COMMIT_ID.test(tree))
		return undefined;
	const dir = madeTemporary();
	if (dir === undefined) return undefined;
	const remove = () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// A scratch folder left behind costs a few bytes of the temporary
			// folder, which the system clears; the gate's answer stands.
		}
	};
	const unread = [
		...["GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"],
		...["GIT_COMMON_DIR"],
		...["GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"],
		...["GIT_CONFIG_SYSTEM", "GIT_ATTR_SOURCE", "GIT_NAMESPACE"],
	].flatMap((name) => ["-u", name]);
	const env = [
		...unread,
		`GIT_DIR=${dir}`,
		`GIT_ALTERNATE_OBJECT_DIRECTORIES=${objects.stdout.trim()}`,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_ATTR_NOSYSTEM=1",
	];
	const bare = ["-c", "core.attributesFile=/dev/null"];
	const made = await exec("env", [
		...env,
		"git",
		...bare,
		"init",
		"--quiet",
		"--bare",
		"--template=",
		dir,
	]);
	if (made.code !== 0) {
		remove();
		return undefined;
	}
	return {
		run: (...args) =>
			exec("env", [...env, "git", ...bare, `--attr-source=${tree}`, ...args]),
		remove,
	};
}

/** A fresh temporary folder, or nothing when one can't be made. */
function madeTemporary(): string | undefined {
	try {
		return mkdtempSync(join(tmpdir(), "reviewed-first-"));
	} catch {
		// A full or unwritable temporary folder: no replay can run, so no
		// earlier council lends, and the refusal says to run one.
		return undefined;
	}
}

/**
 * The commits `branch` pointed at on origin, newest first, as its
 * pushed reflog recalls them; none when the checkout keeps no such
 * reflog.
 */
async function pushedHeads(
	git: (...args: string[]) => ReturnType<Exec>,
	branch: string,
): Promise<string[]> {
	const logged = await git(
		"log",
		"--walk-reflogs",
		"--format=%H",
		`--max-count=${EARLIER_HEADS}`,
		"--end-of-options",
		`refs/remotes/origin/${branch}`,
		"--",
	);
	// No reflog, or no such branch: it recalls no earlier head.
	return logged.code === 0 ? commitIds(logged.stdout) : [];
}

/** Where `head` left `base`, or nothing when that can't be read. */
async function forkOf(
	git: (...args: string[]) => ReturnType<Exec>,
	base: string,
	head: string,
): Promise<string | undefined> {
	const fork = await git("merge-base", "--end-of-options", base, head);
	const from = fork.stdout.trim();
	return fork.code === 0 && COMMIT_ID.test(from) ? from : undefined;
}

/**
 * The tree `head`'s change gives replayed onto `onto`, from where it
 * left `base`: trees, not diffs, so every byte counts, binary or not,
 * and no setting of how a diff is shown can make two changes read the
 * same. Nothing when the replay conflicts or can't be read.
 */
async function replayed(
	git: (...args: string[]) => ReturnType<Exec>,
	scratch: Scratch,
	base: string,
	head: string,
	onto: string,
): Promise<string | undefined> {
	const from = await forkOf(git, base, head);
	if (from === undefined) return undefined;
	// Every argument is a full commit id, read from git itself, so none
	// can be taken for an option; merge-tree takes no `--end-of-options`.
	const merged = await scratch.run(
		"merge-tree",
		"--write-tree",
		"--no-messages",
		`--merge-base=${from}`,
		onto,
		head,
	);
	const tree = merged.stdout.split("\n")[0]?.trim() ?? "";
	return merged.code === 0 && COMMIT_ID.test(tree) ? tree : undefined;
}

/**
 * The remote branches that hold some of `commits` but not `head`, as
 * the commits they point at and their names, leaving out `branch`
 * itself on any remote. Only a branch holding one of the range's
 * roots, the commits whose parents are all outside it, can hold any of
 * it, so only those are asked about, however many branches the clone
 * has.
 */
async function othersHolding(
	git: (...args: string[]) => ReturnType<Exec>,
	head: string,
	branch: string,
	commits: readonly string[],
): Promise<{ commits: string[]; names: string[] } | undefined> {
	if (commits.length === 0) return { commits: [], names: [] };
	const parents = await git(
		"rev-list",
		"--no-walk",
		"--parents",
		"--end-of-options",
		...commits,
	);
	if (parents.code !== 0) return undefined;
	const inRange = new Set(commits);
	const roots = parents.stdout
		.split("\n")
		.map((line) => line.split(" "))
		.filter(
			([commit, ...above]) =>
				commit &&
				COMMIT_ID.test(commit) &&
				!above.some((one) => inRange.has(one)),
		)
		.flatMap(([commit]) => (commit ? [commit] : []));
	const refs = await git(
		"for-each-ref",
		"--format=%(objectname) %(refname:lstrip=3)",
		`--no-contains=${head}`,
		...roots.map((root) => `--contains=${root}`),
		"refs/remotes",
	);
	if (refs.code !== 0) return undefined;
	const held = refs.stdout
		.split("\n")
		.map((line) => line.split(" "))
		.flatMap(([commit, name]) =>
			commit && name && COMMIT_ID.test(commit) && name !== branch
				? [{ commit, name }]
				: [],
		);
	return {
		commits: [...new Set(held.map((one) => one.commit))],
		names: [...new Set(held.map((one) => one.name))],
	};
}

/** The commit ids git printed, one a line. */
function commitIds(stdout: string): string[] {
	return stdout.split("\n").filter((line) => COMMIT_ID.test(line));
}
