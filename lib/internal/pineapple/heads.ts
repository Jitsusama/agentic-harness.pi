/**
 * A pull request's branch, so a stop on one change can tell its pushes
 * from the rest of its repository's.
 *
 * A branch told by name (GitHub's or Delta's own answer) is kept for
 * the session: a branch a change comes from doesn't move while it is
 * open. A lookup that found nothing (GitHub slow, a rate limit, the
 * door down) is asked again once fifteen seconds have passed, since the
 * stop holds every write it can't tell apart, and a failure kept would
 * hold every push to that repository for as long as the stop stands.
 * Within those seconds a write is held at once rather than waiting on
 * another lookup, so one command pushing several branches waits once.
 *
 * Nothing but a lookup's own answer names the branch. A guess from
 * which branch stands at the pull request's head commit was tried and
 * left out: GitHub moves that head after a push to the branch, not with
 * it, so for as long as it lags, another branch left at the old commit
 * looks like the change's own, and the stopped branch's pushes would go
 * through on it.
 *
 * A kept branch is trusted for the session, so a change whose branch is
 * renamed while a stop stands keeps the old name here until pi starts
 * again, and the renamed branch's pushes aren't told apart from the
 * rest.
 */

import type { HeadOf } from "./cover.ts";

/** How long a lookup that found nothing stands before it's asked again. */
export const FAILED_FOR_MS = 15_000;

/** A lookup asked, and once it found nothing, when it settled. */
interface Asked {
	head: Promise<string | undefined>;
	failedAt?: number;
}

/**
 * Each pull request's branch as `ask` tells it, kept once found, and
 * asked again once a lookup that found nothing is `FAILED_FOR_MS` old
 * by `now`. A lookup still under way is shared by every write that asks
 * for it meanwhile, and one that throws tells nothing, as one that fails
 * does, so the stop still holds what it can't tell apart.
 */
export function keptHeads(ask: HeadOf, now = Date.now): HeadOf {
	const told = new Map<string, Asked>();
	return (repo, pr) => {
		if (repo === undefined) return Promise.resolve(undefined);
		const key = `${repo}#${pr}`;
		const known = told.get(key);
		const failedAt = known?.failedAt;
		const stale = failedAt !== undefined && now() - failedAt >= FAILED_FOR_MS;
		if (known && !stale) return known.head;
		const asked: Asked = { head: ask(repo, pr).catch(() => undefined) };
		told.set(key, asked);
		void asked.head.then((head) => {
			if (head === undefined) asked.failedAt = now();
		});
		return asked.head;
	};
}
