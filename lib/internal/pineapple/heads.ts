/**
 * A pull request's branch, asked once a session and kept, so a stop on
 * one change can tell its pushes from the rest of its repository's.
 *
 * Only a branch found is kept: a branch a change comes from doesn't move
 * while it is open. A lookup that found nothing (GitHub slow, a rate
 * limit, the door down) is asked again at the next write, since the stop
 * holds every write it can't tell apart, and a failure kept would hold
 * every push to that repository for as long as the stop stands.
 *
 * Where neither GitHub's nor Delta's tool answers, git's own listing of
 * the repository still can: the pull request's head commit, and the one
 * branch standing at it ({@link headAmong}).
 */

import type { HeadOf } from "./cover.ts";

/** Each pull request's branch as `ask` finds it, found ones kept. */
export function keptHeads(ask: HeadOf): HeadOf {
	const heads = new Map<string, Promise<string | undefined>>();
	return (repo, pr) => {
		if (repo === undefined) return Promise.resolve(undefined);
		const key = `${repo}#${pr}`;
		const known = heads.get(key);
		if (known) return known;
		const asked = ask(repo, pr);
		heads.set(key, asked);
		const forget = () => {
			if (heads.get(key) === asked) heads.delete(key);
		};
		void asked.then((head) => {
			if (head === undefined) forget();
		}, forget);
		return asked;
	};
}

/**
 * The branch of pull request `pr` in `listing`, as `git ls-remote` gives
 * it for `refs/pull/<pr>/head` and `refs/heads/*`: the one branch whose
 * tip is the pull request's head. None when no branch stands there, or
 * more than one does, since then the change can't be told apart.
 */
export function headAmong(listing: string, pr: number): string | undefined {
	const refs = listing
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((parts): parts is [string, string] => parts.length === 2);
	const head = refs.find(([, ref]) => ref === `refs/pull/${pr}/head`)?.[0];
	if (head === undefined) return undefined;
	const branches = refs
		.filter(([sha, ref]) => sha === head && ref.startsWith("refs/heads/"))
		.map(([, ref]) => ref.slice("refs/heads/".length));
	return branches.length === 1 ? branches[0] : undefined;
}
