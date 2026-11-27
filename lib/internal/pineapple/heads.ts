/**
 * A pull request's branch, asked once a session and kept, so a stop on
 * one change can tell its pushes from the rest of its repository's.
 *
 * Only a branch found is kept: a branch a change comes from doesn't move
 * while it is open. A lookup that found nothing (GitHub slow, a rate
 * limit, the door down) is asked again at the next write, since the stop
 * holds every write it can't tell apart, and a failure kept would hold
 * every push to that repository for as long as the stop stands.
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
