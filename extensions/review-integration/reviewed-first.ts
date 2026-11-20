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
 * reflogs in the checkout recall them, count too: one whose whole
 * change, from where it left its base, reads the same as the change's
 * now, line for line though maybe not at the same line numbers, lends
 * the change any council that read one of that head's own commits. A
 * rebase that had to settle a conflict, or brought anything else
 * along, changes the diff and needs a round of its own. Only the last
 * EARLIER_HEADS of each reflog are asked about, and a checkout that
 * never held the branch before its rebase remembers none.
 */

import type { Exec } from "../../lib/core/exec/index.ts";
import { createRunStore } from "../../lib/core/review/index.ts";
import { runDir } from "./engine.ts";

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

/** How many of the branches holding a change's reviewed commits a refusal names. */
const HOLDERS_NAMED = 3;

/** A full commit id, as git prints one a line. */
const COMMIT_ID = /^[0-9a-f]{40}$/;

/** Whether a finished council in `repo` read one of `commits`. */
export type Witnesses = (
	repo: string,
	commits: ReadonlySet<string>,
) => Promise<boolean>;

const onTheLedger: Witnesses = async (repo, commits) =>
	(await createRunStore(runDir()).witnessed(repo, commits)) !== undefined;

let witnesses: Witnesses = onTheLedger;

/** Judge councils by `judge` instead of the ledger, for a test. */
export function witnessCouncilsWith(judge: Witnesses | undefined): void {
	witnesses = judge ?? onTheLedger;
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
	const read = await commitsOf(exec, change);
	const commits = new Set("commits" in read ? read.commits : []);
	if (change.headCommit) commits.add(change.headCommit);
	if (await witnesses(change.repo, commits)) return undefined;
	const range = `${change.base}..${change.head}`;
	if ("unread" in read) {
		return `${range} isn't ${doing}: ${read.unread}, so whether our own council read it can't be told (Joel's rule: our own review before anyone else's). Push the branch, or pass repo naming a checkout that has it, then ask again.`;
	}
	if (await rebasedReviewed(exec, change, read)) return undefined;
	if (
		read.shared.length > 0 &&
		(await witnesses(change.repo, new Set(read.shared)))
	) {
		const named = read.holders.slice(0, HOLDERS_NAMED).join(", ");
		const more = read.holders.length > HOLDERS_NAMED ? " and others" : "";
		return `${range} isn't ${doing} yet: the council of ours that read it read commits ${named}${more} also hold without its head, so they count as that work's, not this change's (Joel's rule: our own review before anyone else's). If those are this change before its last fix, as a branch above it in a stack or an old copy, restack them onto its head or delete them, push, and ask again. Otherwise run review_ask council on this change at its head.`;
	}
	return `No council of ours has read ${range} yet, so it isn't ${doing} (Joel's rule: our own review before anyone else's). A rebase that leaves the change's diff as it was keeps its council; this one has none to keep, or changed what the change does. Run review_ask council on it at its head (base the change below it, for a change in a stack), or review_ask stack over a stack already proposed, as drafts if need be (with an intent saying why, if it refuses another), check each finding against the source, fix and push what holds, then ask again. A draft can go up first: propose with draft true and no reviewers.`;
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
	const unread = {
		unread: `${base}..${head} can't be read in ${change.checkout}`,
	};
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
	if (all === undefined) return unread;
	const others = await othersHolding(git, head, change.head, all);
	if (others === undefined) return unread;
	// A commit is the change's own when no batch of other branches holds
	// it, so each batch's answer narrows what the last left.
	const own = new Set(all);
	for (let at = 0; at < others.commits.length; at += REFS_A_CALL) {
		const kept = await list(...others.commits.slice(at, at + REFS_A_CALL));
		if (kept === undefined) return unread;
		const stays = new Set(kept);
		for (const sha of own) if (!stays.has(sha)) own.delete(sha);
	}
	return {
		commits: all.filter((sha) => own.has(sha)),
		shared: all.filter((sha) => !own.has(sha)),
		holders: others.names,
		base,
		head,
	};
}

/**
 * Whether a council read an earlier head of the change's branch whose
 * whole change reads as the change's does now, so that only a clean
 * rebase stands between them.
 */
async function rebasedReviewed(
	exec: Exec,
	change: ChangeCommits,
	read: { base: string; head: string },
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
	const earlier = (await earlierHeads(git, change.head)).filter(
		(sha) => sha !== now,
	);
	if (earlier.length === 0) return false;
	const wanted = await changeDiff(git, read.base, now);
	if (!wanted) return false;
	const lent = new Set<string>();
	for (const head of earlier) {
		const was = await changeDiff(git, read.base, head);
		if (was?.diff !== wanted.diff) continue;
		const own = await git(
			"rev-list",
			`--max-count=${COMMITS_ASKED}`,
			"--end-of-options",
			`${was.from}..${head}`,
		);
		if (own.code === 0) for (const sha of commitIds(own.stdout)) lent.add(sha);
	}
	return lent.size > 0 && witnesses(change.repo, lent);
}

/**
 * The commits `branch` pointed at before, newest first, as its local
 * and its pushed reflogs recall them; none when it isn't a branch.
 */
async function earlierHeads(
	git: (...args: string[]) => ReturnType<Exec>,
	branch: string,
): Promise<string[]> {
	const heads = new Set<string>();
	for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
		const logged = await git(
			"log",
			"--walk-reflogs",
			"--format=%H",
			`--max-count=${EARLIER_HEADS}`,
			"--end-of-options",
			ref,
			"--",
		);
		// No reflog, or no such branch: it recalls no earlier head.
		if (logged.code === 0)
			for (const sha of commitIds(logged.stdout)) heads.add(sha);
	}
	return [...heads];
}

/**
 * The whole change `head` makes from where it left `base`, and that
 * point, with what a rebase alone changes taken out: the blob ids and
 * the hunks' line numbers. Nothing when it makes none or can't be read,
 * since an empty change matches every branch cut and never pushed on.
 */
async function changeDiff(
	git: (...args: string[]) => ReturnType<Exec>,
	base: string,
	head: string,
): Promise<{ from: string; diff: string } | undefined> {
	const fork = await git("merge-base", "--end-of-options", base, head);
	const from = fork.stdout.trim();
	if (fork.code !== 0 || !COMMIT_ID.test(from)) return undefined;
	const diffed = await git(
		"diff",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--full-index",
		"--end-of-options",
		from,
		head,
		"--",
	);
	if (diffed.code !== 0) return undefined;
	const diff = diffed.stdout
		.split("\n")
		.filter((line) => !line.startsWith("index "))
		.map((line) => (line.startsWith("@@ ") ? "@@" : line))
		.join("\n");
	return diff.trim() === "" ? undefined : { from, diff };
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
