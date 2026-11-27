/**
 * A stack round records a member's head as read only when the tip's
 * history holds it, asked of a real repository: a member below the
 * tip, a sibling branch beside it, and a head git has never seen.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnExec } from "../../../../lib/core/exec/index.ts";
import { stackWitnesses } from "../../../../lib/core/review/ask/stack-witness.ts";
import {
	disposeRepo,
	freshRepo,
	git,
	REAL_GIT_MS,
} from "../../../support/git-fixture.ts";

const repos: string[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) disposeRepo(repo);
});

/** A commit on the branch checked out in `repo`; answers its sha. */
async function commitOn(repo: string, message: string): Promise<string> {
	await git(repo, "commit", "-q", "--allow-empty", "-m", message);
	return git(repo, "rev-parse", "HEAD");
}

/** A stack of base, lower and tip, plus a sibling cut from base. */
async function fannedStack(): Promise<{
	repo: string;
	lower: string;
	tip: string;
	sibling: string;
}> {
	const repo = await freshRepo("stack-witness");
	repos.push(repo);
	const base = await commitOn(repo, "base");
	const lower = await commitOn(repo, "lower");
	const tip = await commitOn(repo, "tip");
	await git(repo, "checkout", "-q", "-b", "sibling", base);
	const sibling = await commitOn(repo, "sibling");
	return { repo, lower, tip, sibling };
}

describe("which stack heads a round may record", () => {
	it(
		"holds the tip and a member below it, and names a sibling as unheld",
		async () => {
			const { repo, lower, tip, sibling } = await fannedStack();
			const witnesses = await stackWitnesses(
				spawnExec(),
				repo,
				tip,
				new Map([
					["lower", lower],
					["sibling", sibling],
					["tip", tip],
				]),
			);
			expect(witnesses.held).toEqual(
				new Map([
					["lower", lower],
					["tip", tip],
				]),
			);
			expect(witnesses.unheld).toEqual(["sibling"]);
		},
		REAL_GIT_MS,
	);

	it(
		"names a head git lacks as unheld, and leaves out a member with none",
		async () => {
			const { repo, tip } = await fannedStack();
			const witnesses = await stackWitnesses(
				spawnExec(),
				repo,
				tip,
				new Map<string, string | undefined>([
					["pushed-since", "1".repeat(40)],
					["unlisted", undefined],
				]),
			);
			expect(witnesses.held.size).toBe(0);
			expect(witnesses.unheld).toEqual(["pushed-since"]);
		},
		REAL_GIT_MS,
	);

	it(
		"holds nothing when the tip lists no head",
		async () => {
			const { repo, lower } = await fannedStack();
			const witnesses = await stackWitnesses(
				spawnExec(),
				repo,
				undefined,
				new Map([["lower", lower]]),
			);
			expect(witnesses.held.size).toBe(0);
			expect(witnesses.unheld).toEqual(["lower"]);
		},
		REAL_GIT_MS,
	);
});
