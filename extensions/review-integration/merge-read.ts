/**
 * Merging only a head our own review read.
 *
 * An audit on 19 November found that since Tue 17 Nov 18:00, 240 of 429
 * merges landed at a head no council or judge of ours saw: a fix pushed
 * after the last round went in unread. So a merge needs a finished council or
 * stack round that read its head, or read an earlier commit of the same
 * change whose patch against its base is the same: a clean rebase
 * changes the commit and not what it does, and asking a council again
 * for it would buy nothing. merge-net's `ready` refuses the same way
 * for core.nix, reading the same ledger the same way.
 *
 * A round on a local range before the change had a number is held under
 * another key, so the head is first asked of every round in the repo.
 * The earlier commits whose patch is compared come from this change's
 * own rounds alone: they are few, and they are the change's by
 * construction.
 */

import type { Exec } from "../../lib/core/exec/index.ts";
import {
	type ChangeRef,
	createRunStore,
	type RunStore,
} from "../../lib/core/review/index.ts";
import { runDir } from "./engine.ts";

/** What a merge's head is read against. */
export interface MergeHead {
	/** The change, as its rounds are held. */
	readonly change: ChangeRef;
	/** The commit about to merge, in full. */
	readonly head: string;
	/** The branch it merges into. */
	readonly base: string;
	/** The checkout to compare patches in. */
	readonly checkout: string;
}

/** A full commit id; a ledger's string is somebody else's to pass to git. */
const COMMIT_ID = /^[0-9a-f]{40}$/;

let rounds: () => RunStore = () => createRunStore(runDir());

/** Read rounds from `store` instead of the ledger, for a test. */
export function readRoundsFrom(store: RunStore | undefined): void {
	rounds = store ? () => store : () => createRunStore(runDir());
}

/** Why a head may not merge, or nothing when a round of ours read it. */
export type HeadReader = (
	exec: Exec,
	merging: MergeHead,
) => Promise<string | undefined>;

let reader: HeadReader = (exec, merging) => unreadHead(exec, merging);

/** Judge heads by `judge` instead of the ledger, for a test. */
export function readHeadsWith(judge: HeadReader | undefined): void {
	reader = judge ?? ((exec, merging) => unreadHead(exec, merging));
}

/** Why `merging.head` may not merge, as the reader in force says. */
export function mergeUnread(
	exec: Exec,
	merging: MergeHead,
): Promise<string | undefined> {
	return reader(exec, merging);
}

/**
 * Why `merging.head` may not merge, since no round of ours read it nor
 * an earlier commit of the same change; or nothing when one did.
 */
export async function unreadHead(
	exec: Exec,
	merging: MergeHead,
): Promise<string | undefined> {
	const store = rounds();
	const { change, head } = merging;
	if (await store.witnessed(change.repo.key, new Set([head]))) {
		return undefined;
	}
	const earlier = (await store.readBy(change)).filter(
		(sha) => COMMIT_ID.test(sha) && sha !== head,
	);
	if (earlier.length > 0) {
		const base = await mergeBase(exec, merging.checkout, merging.base, head);
		const patch = base && (await patchOf(exec, merging.checkout, base, head));
		if (patch) {
			for (const commit of earlier) {
				if ((await patchAgainstBase(exec, merging, commit)) === patch) {
					return undefined;
				}
			}
		}
	}
	return `No review round of ours read ${head.slice(0, 12)}, nor an earlier commit of ${change.label} with the same patch, so it was not merged. Ask a council (review_ask council) at this head, check what it finds, and merge once it's collected.`;
}

/** `commit`'s patch against where it leaves the change's base. */
async function patchAgainstBase(
	exec: Exec,
	merging: MergeHead,
	commit: string,
): Promise<string | undefined> {
	const base = await mergeBase(exec, merging.checkout, merging.base, commit);
	return base ? patchOf(exec, merging.checkout, base, commit) : undefined;
}

/**
 * The commit where `commit` leaves `branch`, as the remote has the
 * branch when it does, or nothing when git can't say.
 */
async function mergeBase(
	exec: Exec,
	checkout: string,
	branch: string,
	commit: string,
): Promise<string | undefined> {
	// A branch name is somebody's string, and git reads one opening with
	// a dash as an option however it is placed.
	if (branch.startsWith("-") || commit.startsWith("-")) return undefined;
	const remote = `origin/${branch}`;
	const known = await exec("git", [
		"-C",
		checkout,
		"rev-parse",
		"--verify",
		"--quiet",
		"--end-of-options",
		`${remote}^{commit}`,
	]);
	const from = known.code === 0 ? remote : branch;
	const found = await exec("git", [
		"-C",
		checkout,
		"merge-base",
		"--end-of-options",
		from,
		commit,
	]);
	const base = found.stdout.trim();
	return found.code === 0 && base ? base : undefined;
}

/**
 * The patch id a review carries by, of `base..commit`, as merge-net
 * reckons it, or nothing when git can't say: with git's lines of context,
 * so the same lines moved within a file are another change, and
 * verbatim, since whitespace is code in some languages; such ids are
 * stable too. Through a shell, since git patch-id reads the diff on its
 * standard input and Exec gives none.
 */
async function patchOf(
	exec: Exec,
	checkout: string,
	base: string,
	commit: string,
): Promise<string | undefined> {
	const said = await exec("sh", [
		"-c",
		'git -C "$1" diff "$2" "$3" | git -C "$1" patch-id --verbatim',
		"sh",
		checkout,
		base,
		commit,
	]);
	const id = said.stdout.trim().split(/\s+/)[0];
	return said.code === 0 && id ? id : undefined;
}
