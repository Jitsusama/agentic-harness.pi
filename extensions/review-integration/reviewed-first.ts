/**
 * Holding a change back from people until our own council has read it.
 *
 * Joel, 17 November: "we must run our own reviews on everything before
 * asking for reviews from others". So a change opened for review, moved
 * to ready, or put to reviewers needs a finished council whose reviewers
 * read one of its commits; one read before a last fix still counts,
 * since what it found was fixed on top of it. A draft goes up without
 * one, since nobody is asked to look at a draft.
 *
 * The commits are read from the checkout: a range from the change's
 * base to its head. One that can't be read counts no council, so the
 * answer then is to run one at the head, which the refusal says.
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

/**
 * Why `doing` must wait for a council of ours, or nothing when one has
 * read a commit of the change.
 */
export async function councilFirst(
	exec: Exec,
	change: ChangeCommits,
	doing: string,
): Promise<string | undefined> {
	const commits = new Set(await commitsOf(exec, change));
	if (change.headCommit) commits.add(change.headCommit);
	if (await witnesses(change.repo, commits)) {
		return undefined;
	}
	return `No council of ours has read ${change.base}..${change.head} yet, so it isn't ${doing} (Joel's rule: our own review before anyone else's). Run review_ask council on it at its head, check each finding against the source, fix and push what holds, then ask again. A draft can go up first: propose with draft true.`;
}

/** The change's commits, newest first, or none when they can't be read. */
async function commitsOf(exec: Exec, change: ChangeCommits): Promise<string[]> {
	const git = (...args: string[]) =>
		exec("git", ["-C", change.checkout, ...args]);
	const remote = `origin/${change.base}`;
	const known = await git("rev-parse", "--verify", "--quiet", remote);
	const base = known.code === 0 ? remote : change.base;
	const head = change.headCommit ?? change.head;
	const listed = await git(
		"rev-list",
		`--max-count=${COMMITS_ASKED}`,
		`${base}..${head}`,
	);
	if (listed.code !== 0) return [];
	return listed.stdout
		.split("\n")
		.filter((line) => /^[0-9a-f]{40}$/.test(line));
}
