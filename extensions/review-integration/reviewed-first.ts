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
 * reflogs in the checkout recall them, count too, and so do the commits
 * under each above the base, since a branch can pass through a commit
 * without its head resting there: two commits pushed at once, or a
 * room's patch applied in another tree. A council that read one of
 * them lends itself to the change when that commit is its branch's own
 * work, as the change's own commits are judged, and its change,
 * replayed by git from where it left the base onto where the change
 * leaves it now, gives byte for byte the tree of the change's head or
 * of one of its own commits below it, as a fix after a council keeps
 * it. After a restack the commits under an earlier head are the old
 * copies of a lower branch's, which no pushed branch holds any more;
 * an upper branch cut from the lower one holds them at or under where
 * it was made, so they lend nothing, as below, and wherever they lie
 * their replay gives the lower branch's tree, not the upper's. Only
 * COMMITS_ASKED of each earlier head's commits are asked about, the
 * heads first. A rebase that had to settle a conflict, or brought
 * anything else along, gives another tree and needs a round of its
 * own; so the replay runs in a scratch repo
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

import { constants as fsConstants, mkdtempSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Exec } from "../../lib/core/exec/index.ts";
import { createRunStore } from "../../lib/core/review/index.ts";
import { removeTree } from "../../lib/internal/files/remove-tree.ts";
import { mirroredRunsDir, runDir } from "./engine.ts";

/** How many of a change's commits are asked about, newest first. */
const COMMITS_ASKED = 500;

/**
 * How many remote branches a range asks about, at most. Asking which
 * branches hold a commit walks each one's history, which over World's
 * tens of thousands of remote branches took minutes and loaded the
 * machine; past this many a range can't be read rather than walked. It
 * also keeps every command naming them well short of what the kernel
 * takes.
 */
const BRANCHES_ASKED = 300;

/** What a range answers when its clone has more remote branches than it asks about. */
const CROWDED = "crowded";

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

/**
 * The mirrors under runs-from that could be read, and, as sentences,
 * why the rest, or the folder itself, couldn't be.
 */
interface Mirrors {
	readonly ledgers: readonly string[];
	readonly trouble: readonly string[];
}

/**
 * This machine's ledger, then, only on a miss, each mirrored one. A
 * council run on another machine of the realm is still our own review:
 * equilibrius runs rounds while optimus's memory holds councils back,
 * and its ledger is mirrored here rather than merged into ours. The
 * mirrors are listed once for the judgement, however often it asks.
 *
 * runs-from is the machine's, as runs is, so a mirror counts for every
 * realm here. Whatever fills it is trusted as this machine's own ledger
 * is: the other machine, anything there that can write its ledger, the
 * copy between, and whoever writes where a node's link leads. A council
 * entry carries no proof it ran, so the gate is only as true as they
 * are. A node is meant to be a local copy: a link to a network mount
 * that hangs would hang the gate with it.
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
			const nodes = ledgers.map((ledger) => basename(ledger)).join(", ");
			const asked =
				ledgers.length > 0
					? [`Asked this machine's ledger and those mirrored from ${nodes}.`]
					: [];
			return [...asked, ...trouble].map((line) => ` ${line}`).join("");
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
		if (hasCode(error, "ENOENT")) return { ledgers: [], trouble: [] };
		return {
			ledgers: [],
			trouble: [
				`The councils mirrored under ${root} couldn't be listed (${messageOf(error)}), so only this machine's ledger was asked.`,
			],
		};
	}
	const ledgers: string[] = [];
	const trouble: string[] = [];
	const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name));
	for (const node of sorted) {
		if (!node.isDirectory() && !node.isSymbolicLink()) continue;
		const path = join(root, node.name);
		const read = await readNode(path, node.isSymbolicLink());
		if (read.kind === "file") continue;
		if (read.kind === "unread") {
			trouble.push(
				`The mirror from ${node.name} couldn't be read (${read.why}), so it wasn't asked.`,
			);
			continue;
		}
		ledgers.push(path);
		if (read.oneTooHigh) {
			trouble.push(
				`The mirror from ${node.name} holds a runs folder and no ledger, as if mirrored one folder too high.`,
			);
		}
	}
	return { ledgers, trouble };
}

/** What a node under runs-from turned out to be when listed. */
type NodeRead =
	| { kind: "folder"; oneTooHigh: boolean }
	| { kind: "file" }
	| { kind: "unread"; why: string };

/**
 * List a node's folder, following a link, and open each ledger it
 * lists, so one that can't be read is said rather than asked and taken
 * as empty: the store reading it later passes over a file it can't
 * open without a word, and a folder that lists can still hold files
 * that don't open. A link to a file is a stray, like a file beside the
 * folders.
 */
async function readNode(path: string, isLink: boolean): Promise<NodeRead> {
	let names: string[];
	try {
		names = await readdir(path);
	} catch (error) {
		if (hasCode(error, "ENOTDIR")) return { kind: "file" };
		if (hasCode(error, "ENOENT")) {
			const why = isLink ? "it is a link to nothing" : "it was gone when read";
			return { kind: "unread", why };
		}
		return { kind: "unread", why: messageOf(error) };
	}
	const ledgers = names.filter((name) => name.endsWith(".json"));
	for (const name of ledgers) {
		try {
			await access(join(path, name), fsConstants.R_OK);
		} catch (error) {
			// A ledger the mirror replaced between the listing and here is
			// read afresh by the store; only one that is there and won't
			// open leaves the node unread.
			if (hasCode(error, "ENOENT")) continue;
			return {
				kind: "unread",
				why: `its ledger ${name} wouldn't open: ${messageOf(error)}`,
			};
		}
	}
	const oneTooHigh = names.includes("runs") && ledgers.length === 0;
	return { kind: "folder", oneTooHigh };
}

/** An error's message, or the thing thrown as text. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The entries under runs-from, with their types. */
function readNodes(root: string) {
	return readdir(root, { withFileTypes: true });
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
	| { unread: string }
	/** Its head commit, in a clone with more remote branches than a range asks about. */
	| { crowded: string };

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
	// A branch holding the head is never one of its range's holders, so
	// the head is always the change's own: a council that read it read
	// this change, however many branches the clone has.
	if ("crowded" in read) commits.add(read.crowded);
	if (await witnessed(change.repo, commits)) return undefined;
	const range = `${change.base}..${change.head}`;
	if ("crowded" in read) {
		return `${range} isn't ${doing}: ${change.checkout} has more than ${BRANCHES_ASKED} remote branches, too many to ask which of them hold its commits, so only a council of ours that read its head, ${read.crowded}, lets it through (Joel's rule: our own review before anyone else's). Run review_ask council on it at its head, then ask again.${await said()}`;
	}
	if ("unread" in read) {
		return `${range} isn't ${doing}: ${read.unread}, so whether our own council read it can't be told (Joel's rule: our own review before anyone else's). Push the branch, or pass repo naming a checkout that has it, then ask again.${await said()}`;
	}
	if (await rebasedReviewed(exec, change, read, witnessed)) return undefined;
	if (
		read.shared.length > 0 &&
		(await witnessed(change.repo, new Set(read.shared)))
	) {
		const named = read.holders.slice(0, HOLDERS_NAMED).join(", ");
		const more = read.holders.length > HOLDERS_NAMED ? " and others" : "";
		return `${range} isn't ${doing} yet: the council of ours that read it read commits ${named}${more} also hold without its head, so they count as that work's, not this change's (Joel's rule: our own review before anyone else's). If those are this change before its last fix, as a branch above it in a stack or an old copy, restack them onto its head or delete them, push, and ask again. Otherwise run review_ask council on this change at its head.${await said()}`;
	}
	return `No council of ours has read ${range} yet, so it isn't ${doing} (Joel's rule: our own review before anyone else's). (A rebase keeps a council when the commit it read is among the last ${EARLIER_HEADS} heads this checkout's reflogs recall, or under one of them, the branch's reflog here reaches back to its making, that commit is its own work above wherever it was made, reset or fast-forwarded to, and git replays it onto the new base cleanly to this change's tree, or to one of its commits below a fix.) Run review_ask council on it at its head (base the change below it, for a change in a stack), or review_ask stack over a stack already proposed, as drafts if need be (with an intent saying why, if it refuses another), check each finding against the source, fix and push what holds, then ask again. A draft can go up first: propose with draft true and no reviewers.${await said()}`;
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
	if (range === CROWDED) {
		const tip = await git(
			"rev-parse",
			"--verify",
			"--quiet",
			"--end-of-options",
			`${head}^{commit}`,
		);
		const commit = tip.stdout.trim();
		if (tip.code === 0 && COMMIT_ID.test(commit)) return { crowded: commit };
	}
	return range && range !== CROWDED
		? { ...range, base, head }
		: { unread: `${base}..${head} can't be read in ${change.checkout}` };
}

/**
 * The commits from `base` to `head` that are `branch`'s own, and those
 * another pushed branch holds without `head`, with those branches'
 * names; crowded when the clone has more remote branches than are
 * asked about, and nothing when they can't be read.
 */
async function rangeOf(
	git: (...args: string[]) => ReturnType<Exec>,
	base: string,
	head: string,
	branch: string,
): Promise<
	| { commits: string[]; shared: string[]; holders: string[] }
	| typeof CROWDED
	| undefined
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
	if (others === undefined || others === CROWDED) return others;
	// A commit is the change's own when no other branch holds it.
	const kept = others.commits.length > 0 ? await list(...others.commits) : all;
	if (kept === undefined) return undefined;
	const own = new Set(kept);
	return {
		commits: all.filter((sha) => own.has(sha)),
		shared: all.filter((sha) => !own.has(sha)),
		holders: others.names,
	};
}

/**
 * Whether a council read an earlier head of the change's branch, or a
 * commit under one above the base, its own work then, whose change
 * replayed onto the base the change sits on now gives the tree of the
 * change's head or of one of its own commits, so that only a clean
 * rebase, and fixes after it, stand between them.
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
	if (earlier.length === 0) return false;
	const passed = await passedThrough(git, read.base, earlier);
	// One look at the ledger before any replay, since most changes
	// refused were never read at all.
	const reviewed = await witnessedAmong(witnesses, change.repo, passed);
	if (reviewed.length === 0) return false;
	const onto = await forkOf(git, read.base, now);
	const trees = await ownTrees(git, read.base, now, read.commits);
	if (onto === undefined || trees === undefined) return false;
	const scratch = await scratchRepo(exec, git);
	if (scratch === undefined) return false;
	try {
		for (const commit of reviewed) {
			if (await atOrBelowAny(git, commit, history.arrivals)) continue;
			const tree = await replayed(git, scratch, read.base, commit, onto);
			if (tree === undefined || !trees.has(tree)) continue;
			if (await ownWherever(git, read.base, commit, earlier, change.head))
				return true;
		}
		return false;
	} finally {
		scratch.remove();
	}
}

/**
 * The commits the branch held or passed through at its earlier `heads`:
 * the heads themselves first, in their order, then the commits under
 * each from `base`, at most COMMITS_ASKED of each, newest first, none
 * twice. A head whose range can't be read adds only itself.
 */
async function passedThrough(
	git: (...args: string[]) => ReturnType<Exec>,
	base: string,
	heads: readonly string[],
): Promise<string[]> {
	const passed = new Set(heads);
	for (const head of heads) {
		const listed = await git(
			"rev-list",
			`--max-count=${COMMITS_ASKED}`,
			"--end-of-options",
			`${base}..${head}`,
		);
		if (listed.code !== 0) continue;
		for (const commit of commitIds(listed.stdout)) passed.add(commit);
	}
	return [...passed];
}

/**
 * Which of `commits` a council read, in their order. The ledger is
 * asked over all of them first, then over halves of each set it says
 * holds one, so the few read among thousands cost a few asks each
 * rather than one ask a commit.
 */
async function witnessedAmong(
	witnesses: Witnesses,
	repo: string,
	commits: readonly string[],
): Promise<string[]> {
	if (commits.length === 0) return [];
	if (!(await witnesses(repo, new Set(commits)))) return [];
	if (commits.length === 1) return [...commits];
	const half = Math.ceil(commits.length / 2);
	return [
		...(await witnessedAmong(witnesses, repo, commits.slice(0, half))),
		...(await witnessedAmong(witnesses, repo, commits.slice(half))),
	];
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
		// Past the branches asked about, nothing is lent.
		if (range === undefined || range === CROWDED) return false;
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
			removeTree(dir);
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
 * it, so only those are asked about. Only a clone with at most
 * `BRANCHES_ASKED` remote branches is asked: past that it is crowded,
 * as whether they hold any can't be read without walking them all.
 */
async function othersHolding(
	git: (...args: string[]) => ReturnType<Exec>,
	head: string,
	branch: string,
	commits: readonly string[],
): Promise<
	{ commits: string[]; names: string[] } | typeof CROWDED | undefined
> {
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
	// Listing them, one past the bound, reads no history, however many
	// there are.
	const listed = await git(
		"for-each-ref",
		`--count=${BRANCHES_ASKED + 1}`,
		"--format=%(refname)",
		"refs/remotes",
	);
	if (listed.code !== 0) return undefined;
	const remotes = listed.stdout.split("\n").filter((name) => name !== "");
	if (remotes.length > BRANCHES_ASKED) return CROWDED;
	if (remotes.length === 0) return { commits: [], names: [] };
	// Named in full, only these are walked, though more arrive meanwhile.
	const refs = await git(
		"for-each-ref",
		"--format=%(objectname) %(refname:lstrip=3)",
		`--no-contains=${head}`,
		...roots.map((root) => `--contains=${root}`),
		...remotes,
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
