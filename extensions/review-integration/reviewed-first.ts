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
 * a stack holds its head, so its commits stay its own. One that can't
 * be read is said as that, not as a missing council, so nobody pays for
 * a council that would be refused the same way.
 */

import type { Exec } from "../../lib/core/exec/index.ts";
import { createRunStore } from "../../lib/core/review/index.ts";
import { runDir } from "./engine.ts";

/** How many of a change's commits are asked about, newest first. */
const COMMITS_ASKED = 500;

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

/** The change's commits, or why they couldn't be read. */
type Read = { commits: string[] } | { unread: string };

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
	if ("unread" in read) {
		return `${change.base}..${change.head} isn't ${doing}: ${read.unread}, so whether our own council read it can't be told (Joel's rule: our own review before anyone else's). Push the branch, or pass repo naming a checkout that has it, then ask again.`;
	}
	return `No council of ours has read ${change.base}..${change.head} yet, so it isn't ${doing} (Joel's rule: our own review before anyone else's). Run review_ask council on it at its head, or review_ask stack over the stack it sits in (with an intent saying why, if it refuses another), check each finding against the source, fix and push what holds, then ask again. A draft can go up first: propose with draft true and no reviewers.`;
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
	const others = await git(
		"for-each-ref",
		"--format=%(objectname)",
		`--no-contains=${head}`,
		"refs/remotes",
	);
	if (others.code !== 0) {
		return { unread: `${head} can't be read in ${change.checkout}` };
	}
	const elsewhere = [
		...new Set(
			others.stdout.split("\n").filter((line) => /^[0-9a-f]{40}$/.test(line)),
		),
	].map((sha) => `^${sha}`);
	const listed = await git(
		"rev-list",
		`--max-count=${COMMITS_ASKED}`,
		"--end-of-options",
		`${base}..${head}`,
		...elsewhere,
	);
	if (listed.code !== 0) {
		return {
			unread: `${base}..${head} can't be read in ${change.checkout}`,
		};
	}
	return {
		commits: listed.stdout
			.split("\n")
			.filter((line) => /^[0-9a-f]{40}$/.test(line)),
	};
}
