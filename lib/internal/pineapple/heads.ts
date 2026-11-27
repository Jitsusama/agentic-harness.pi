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
export function keptHeads(ask: HeadOf, now = () => performance.now()): HeadOf {
	const told = new Map<string, Asked>();
	return (repo, pr) => {
		if (repo === undefined) return Promise.resolve(undefined);
		const key = `${repo}#${pr}`;
		const known = told.get(key);
		const failedAt = known?.failedAt;
		const age = failedAt === undefined ? undefined : now() - failedAt;
		// A clock stepped back reads as stale rather than holding for as
		// long as it stepped.
		const stale = age !== undefined && (age >= FAILED_FOR_MS || age < 0);
		if (known && !stale) return known.head;
		const asked: Asked = { head: ask(repo, pr).catch(() => undefined) };
		told.set(key, asked);
		void asked.head.then((head) => {
			if (head === undefined) asked.failedAt = now();
		});
		return asked.head;
	};
}

/**
 * What a program prints, trimmed, or nothing where it failed, timed out
 * or said nothing, so an unknown answer never names a branch.
 */
export type Look = (
	program: string,
	args: string[],
) => Promise<string | undefined>;

/**
 * A pull request's branch, asked of GitHub and Delta at once and taken
 * from GitHub where it answers, so a write waits for the slower only
 * when GitHub tells nothing. A blank answer, or one Delta gives as a
 * whole ref, is read as the short name a push is judged by, or none.
 */
export function askedHead(look: Look): HeadOf {
	return async (repo, pr) => {
		if (repo === undefined) return undefined;
		const delta = deltaHead(look, repo, pr).catch(() => undefined);
		const github = await look("gh", [
			"pr",
			"view",
			String(pr),
			"-R",
			repo,
			"--json",
			"headRefName",
			"-q",
			".headRefName",
		]).catch(() => undefined);
		return shortName(github) ?? (await delta);
	};
}

async function deltaHead(
	look: Look,
	repo: string,
	pr: number,
): Promise<string | undefined> {
	const json = await look("dt", [
		"pr",
		"view",
		String(pr),
		"-R",
		repo,
		"--json",
	]);
	if (json === undefined) return undefined;
	try {
		const view = JSON.parse(json) as {
			head?: { ref?: unknown };
			headRefName?: unknown;
		} | null;
		const ref = view?.head?.ref ?? view?.headRefName;
		return typeof ref === "string" ? shortName(ref) : undefined;
	} catch {
		// Not JSON: Delta didn't say, and the stop holds the write.
		return undefined;
	}
}

/** A branch's short name, as a push names it, or none where it's blank. */
function shortName(ref: string | undefined): string | undefined {
	const name = ref?.trim().replace(/^refs\/heads\//, "");
	return name === undefined || name === "" ? undefined : name;
}
