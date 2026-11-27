/**
 * A pull request's branch, so a stop on one change can tell its pushes
 * from the rest of its repository's.
 *
 * A branch told by name (GitHub's or Delta's own answer) is kept for
 * the session: a branch a change comes from doesn't move while it is
 * open. A lookup that found nothing (GitHub slow, a rate limit, the
 * door down) is asked again at the next write, since the stop holds
 * every write it can't tell apart, and a failure kept would hold every
 * push to that repository for as long as the stop stands.
 *
 * Where no lookup tells the branch, git's own listing of the repository
 * can still guess it: the one branch standing at the pull request's head
 * commit ({@link headAmong}). A guess is never kept. GitHub moves a pull
 * request's head after a push to its branch, not with it, so for a
 * moment another branch left at the old commit can look like the
 * change's own. Kept, that guess would let the stopped branch's pushes
 * through for the rest of the session; asked each time, it can be wrong
 * only for a write made in that moment.
 *
 * Until a branch is found, the guess is asked beside the lookup rather
 * than after it, so a write held while every answer is slow waits for
 * the slowest, not for each in turn.
 */

import type { Exec } from "../../core/exec/index.ts";
import type { HeadOf } from "./cover.ts";

/**
 * Each pull request's branch as `ask` tells it, kept once found, and
 * otherwise as `guess`, asked afresh beside `ask` until a branch is
 * found. A lookup or guess still under way is shared by every write that
 * asks for it meanwhile.
 */
export function keptHeads(ask: HeadOf, guess?: HeadOf): HeadOf {
	const found = new Map<string, string>();
	const told = new Map<string, Promise<string | undefined>>();
	const guessing = new Map<string, Promise<string | undefined>>();
	const guessed = (key: string, repo: string, pr: number) => {
		const known = guessing.get(key);
		if (known) return known;
		const asked = guess ? guess(repo, pr) : Promise.resolve(undefined);
		guessing.set(key, asked);
		const forget = () => {
			if (guessing.get(key) === asked) guessing.delete(key);
		};
		void asked.then(forget, forget);
		return asked;
	};
	const tellOf = (key: string, repo: string, pr: number) => {
		const known = told.get(key);
		if (known) return known;
		const asked = ask(repo, pr);
		told.set(key, asked);
		const forget = () => {
			if (told.get(key) === asked) told.delete(key);
		};
		void asked.then((head) => {
			if (head === undefined) forget();
			else found.set(key, head);
		}, forget);
		return asked;
	};
	return (repo, pr) => {
		if (repo === undefined) return Promise.resolve(undefined);
		const key = `${repo}#${pr}`;
		const known = found.get(key);
		if (known !== undefined) return Promise.resolve(known);
		const telling = tellOf(key, repo, pr);
		const guessing = guessed(key, repo, pr);
		return telling.then((head) => head ?? guessing);
	};
}

/**
 * The branch of pull request `pr` of the repository at `url`, guessed
 * from git's listing of it ({@link headAmong}). None when the listing
 * fails or can't tell.
 */
export async function listedHead(
	exec: Exec,
	url: string,
	pr: number,
): Promise<string | undefined> {
	const listed = await exec("git", [
		"ls-remote",
		url,
		`refs/pull/${pr}/head`,
		"refs/heads/*",
	]);
	return listed.code === 0 ? headAmong(listed.stdout, pr) : undefined;
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
