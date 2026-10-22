/**
 * A local range as something a council can be asked about.
 *
 * Rounds and findings are held against a change, so a range needs a name
 * that stays put and a description built from its own commits. Run against
 * a real repository, since what is being checked is what git says.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoundTarget } from "@jitsusama/agentic-harness.core/review";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	RANGE_PROVIDER,
	rangeChange,
	rangeProposal,
} from "../../extensions/review-integration/range.ts";
import { reviewedChange } from "../../extensions/review-integration/tools/shared.ts";
import { disposeRepo, freshRepo, git } from "../support/git-fixture.ts";

let repo: string;

beforeEach(async () => {
	repo = await freshRepo("review-range");
});

afterEach(() => {
	disposeRepo(repo);
});

/** A bound target for base..head in the fixture, as the core binds one. */
function boundRange(base: string, head: string): BoundTarget {
	const local = { key: `local:${repo}`, localPath: repo };
	return {
		target: { kind: "range", repo: local, base, head },
		// A hosted repo's locator carries no path; the target's does.
		repo: { key: "github:owner/name" },
		provider: { id: "github" },
	} as unknown as BoundTarget;
}

async function commit(file: string, message: string): Promise<void> {
	writeFileSync(join(repo, file), `${file}\n`);
	await git(repo, "add", file);
	await git(
		repo,
		"commit",
		"-q",
		...message.split("\n\n").flatMap((part) => ["-m", part]),
	);
}

describe("a local range as a change", () => {
	it("is held under its own name and a provider no host answers to", () => {
		const change = rangeChange(boundRange("main", "topic"));

		expect(change).toEqual({
			provider: RANGE_PROVIDER,
			repo: { key: "github:owner/name" },
			id: "main..topic",
			label: "main..topic in github:owner/name",
		});
		expect(reviewedChange(boundRange("main", "topic"))).toEqual(change);
	});

	it("is nothing for a list of refs, which goes to the roster as a stack", () => {
		const bound = {
			target: { kind: "stack", repo: { key: "local:x" }, refs: ["a", "b"] },
			repo: { key: "local:x" },
		} as unknown as BoundTarget;

		expect(rangeChange(bound)).toBeUndefined();
		expect(reviewedChange(bound)).toBeUndefined();
	});

	it("tells its commits as a proposal pinned to the head it names now", async () => {
		await git(repo, "checkout", "-q", "-b", "topic");
		await commit("a.ts", "feat: add a\n\nBecause a is needed.");
		await commit("b.ts", "fix: mend b");
		const head = await git(repo, "rev-parse", "HEAD");
		const bound = boundRange("main", "topic");

		const proposal = await rangeProposal(bound);

		expect(proposal).toMatchObject({
			ref: rangeChange(bound),
			title: "2 commits from main to topic",
			body: "feat: add a\n\nBecause a is needed.\n\nfix: mend b",
			author: { id: "Test" },
			base: "main",
			head: "topic",
			headCommit: head,
		});
	});

	it("takes a lone commit's subject as its title", async () => {
		await git(repo, "checkout", "-q", "-b", "topic");
		await commit("a.ts", "feat: add a");

		const proposal = await rangeProposal(boundRange("main", "topic"));

		expect(proposal?.title).toBe("feat: add a");
	});

	it("refuses a range that holds no commits, since there is nothing to review", async () => {
		await expect(rangeProposal(boundRange("main", "main"))).rejects.toThrow(
			/holds no commits/,
		);
	});
});
