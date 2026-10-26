/**
 * Publishing a branch.
 *
 * The step that was missing: `work record` committed and `review_offer
 * propose` needed the branch on the remote, and the only way between them was
 * a shell. These tests are about argv and about refusals, since the two things
 * that make a push dangerous are where it sends the branch and what it
 * overwrites when it gets there.
 */

import { describe, expect, it } from "vitest";
import {
	createGitPublisher,
	refspecCovers,
} from "../../../lib/core/work/publish.ts";
import { fakeExec } from "../support/fake-exec.ts";

const TREE = "/trees/topic";

/**
 * What `topic`'s settings say it follows: a remote and the branch there,
 * or nothing. They come before any reply to `remote`, since the fake
 * matches fragments as substrings and `branch.topic.remote` holds one.
 */
function following(remote?: string, merge = "refs/heads/topic") {
	return remote === undefined
		? [{ when: ["config", "--get", "branch.topic."], code: 1 }]
		: [
				{
					when: ["config", "--get", "branch.topic.remote"],
					stdout: `${remote}\n`,
				},
				{
					when: ["config", "--get", "branch.topic.merge"],
					stdout: `${merge}\n`,
				},
			];
}

/** A tree on `topic`, tracking `origin/topic`, with an origin remote. */
const tracked = [
	{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
	...following("origin"),
	{ when: ["remote"], stdout: "origin\n" },
	{ when: ["push"], stdout: "", stderr: "To github.com\n" },
];

/** The same tree, on a branch that has never been pushed. */
const untracked = [
	{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
	...following(),
	{ when: ["remote"], stdout: "origin\n" },
	{ when: ["push"], stdout: "", stderr: "To github.com\n" },
];

/** The push git ran, as one string. */
function pushArgs(calls: { args: string[] }[]): string {
	return (calls.find((call) => call.args.includes("push"))?.args ?? []).join(
		" ",
	);
}

describe("publishing a branch", () => {
	it("sets upstream on a branch that has none", async () => {
		// Without this a branch has to be told its own name on every later
		// push, and eventually gets told the wrong one.
		const { exec, calls } = fakeExec(untracked);

		const outcome = await createGitPublisher({ exec }).push(TREE);

		expect(pushArgs(calls)).toContain("--set-upstream");
		expect(outcome).toMatchObject({ kind: "published", tracked: true });
	});

	it("does not set upstream again on a branch that has one", async () => {
		const { exec, calls } = fakeExec(tracked);

		const outcome = await createGitPublisher({ exec }).push(TREE);

		expect(pushArgs(calls)).not.toContain("--set-upstream");
		expect(outcome).toMatchObject({ kind: "published", tracked: false });
	});

	it("pushes to the branch's own upstream rather than assuming origin", async () => {
		// Pushing a tracked branch somewhere else is how a fork ends up with a
		// copy of a branch nobody is watching.
		const { exec, calls } = fakeExec([
			{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
			...following("upstream"),
			{ when: ["remote"], stdout: "origin\nupstream\n" },
			{ when: ["push"], stderr: "To elsewhere\n" },
		]);

		await createGitPublisher({ exec }).push(TREE);

		expect(pushArgs(calls)).toContain("upstream topic");
	});

	it("scopes every call to the tree", async () => {
		// The exec seam has no working directory, so an unscoped git call runs
		// wherever the process sits and answers about the wrong repository.
		const { exec, calls } = fakeExec(tracked);

		await createGitPublisher({ exec }).push(TREE);

		for (const call of calls) {
			expect(call.args.slice(0, 2)).toEqual(["-C", TREE]);
		}
	});
});

describe("whether a fetch refspec brings a branch in", () => {
	it("reads a pattern, a single ref and a forced one alike", () => {
		const topic = "refs/heads/jg/topic";
		expect(refspecCovers("+refs/heads/*:refs/remotes/origin/*", topic)).toBe(
			true,
		);
		expect(
			refspecCovers("refs/heads/jg/*:refs/remotes/origin/jg/*", topic),
		).toBe(true);
		expect(refspecCovers(`+${topic}:refs/remotes/origin/jg/topic`, topic)).toBe(
			true,
		);
	});

	it("is false for another branch and for a refspec that leaves refs out", () => {
		const topic = "refs/heads/jg/topic";
		expect(
			refspecCovers("+refs/heads/main:refs/remotes/origin/main", topic),
		).toBe(false);
		expect(refspecCovers("^refs/heads/jg/*", topic)).toBe(false);
		expect(refspecCovers("", topic)).toBe(false);
	});
});

describe("replacing what the remote has", () => {
	it("leases the force rather than taking it", async () => {
		// A bare force overwrites whatever arrived while you were rebasing,
		// which on a shared branch is somebody else's work.
		const { exec, calls } = fakeExec(tracked);

		await createGitPublisher({ exec }).push(TREE, { replace: true });

		expect(pushArgs(calls)).toContain("--force-with-lease");
		expect(pushArgs(calls)).not.toMatch(/--force(?!-with-lease)/);
	});

	it("explains a refused lease as work that arrived, not as a failure", async () => {
		const { exec } = fakeExec([
			...tracked.slice(0, -1),
			{
				when: ["push"],
				code: 1,
				stderr: "! [rejected] topic -> topic (stale info)\n",
			},
		]);

		const outcome = await createGitPublisher({ exec }).push(TREE, {
			replace: true,
		});

		expect(outcome.kind).toBe("refused");
		expect(outcome).toHaveProperty("reason", expect.stringContaining("moved"));
		expect(outcome).toHaveProperty("reason", expect.stringContaining("Fetch"));
	});
});

describe("refusing to publish", () => {
	it("refuses a detached head, and says how to get a branch", async () => {
		const { exec } = fakeExec([
			{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "HEAD\n" },
		]);

		const outcome = await createGitPublisher({ exec }).push(TREE);

		expect(outcome).toMatchObject({ kind: "refused" });
		expect(outcome).toHaveProperty("reason", expect.stringContaining("branch"));
	});

	it("publishes to origin a branch that follows one of this repo's own", async () => {
		// `git checkout -b topic main --track` records the remote as `.`,
		// which is this repo rather than anywhere to push to.
		const { exec, calls } = fakeExec([
			{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
			...following(".", "refs/heads/main"),
			{ when: ["remote"], stdout: "origin\n" },
			{ when: ["push"], stderr: "To github.com\n" },
		]);

		const outcome = await createGitPublisher({ exec }).push(TREE);

		expect(pushArgs(calls)).toContain("--set-upstream origin topic");
		expect(outcome).toMatchObject({ kind: "published", tracked: true });
	});

	it("names the remotes it does have when the one asked for is absent", async () => {
		const { exec } = fakeExec([
			{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
			...following(),
			{ when: ["remote"], stdout: "origin\nfork\n" },
		]);

		const outcome = await createGitPublisher({ exec }).push(TREE, {
			remote: "upstream",
		});

		expect(outcome).toHaveProperty("reason", expect.stringContaining("origin"));
		expect(outcome).toHaveProperty("reason", expect.stringContaining("fork"));
	});

	it("says a push that changed nothing changed nothing", async () => {
		// Reported rather than dressed as success, because "published" about a
		// no-op is how somebody concludes their commit went up when it did not.
		const { exec } = fakeExec([
			...tracked.slice(0, -1),
			{ when: ["push"], stdout: "Everything up-to-date\n" },
		]);

		const outcome = await createGitPublisher({ exec }).push(TREE);

		expect(outcome).toMatchObject({ kind: "already-there", branch: "topic" });
	});
});

describe("a branch that has diverged from its remote", () => {
	// Git reports this with a hint to run `git pull`. That hint is why the case is
	// handled instead of passed along: the commonest way to arrive here is having
	// rebased, and pulling merges the old history back into the rewritten one,
	// producing the tangle the rebase was for. This layer does the rebasing, so it
	// is the layer that knows.
	const rejected = [
		{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
		...following("origin"),
		// Before `remote`, which `refs/remotes/` would match too.
		{
			when: [
				"rev-list",
				"--left-right",
				"--count",
				"refs/heads/topic...refs/remotes/origin/topic",
			],
			stdout: "5\t3\n",
		},
		{ when: ["remote"], stdout: "origin\n" },
		{
			when: ["push"],
			code: 1,
			stderr:
				" ! [rejected]        topic -> topic (non-fast-forward)\nhint: Updates were rejected because the tip of your current branch is behind\nhint: use 'git pull' before pushing again.\n",
		},
	];

	it("points at the lease rather than at a pull", async () => {
		const { exec } = fakeExec(rejected);

		const outcome = await createGitPublisher({ exec }).push(TREE);

		expect(outcome).toMatchObject({ kind: "refused", branch: "topic" });
		if (outcome.kind !== "refused") return;
		expect(outcome.reason).toContain("replace");
		expect(outcome.reason).toContain("lease");
	});

	it("says how far apart the two are, in both directions", async () => {
		// Which side is ahead is what tells a reader whether they rebased or
		// somebody else pushed, and one number cannot say it.
		const { exec } = fakeExec(rejected);

		const outcome = await createGitPublisher({ exec }).push(TREE);

		if (outcome.kind !== "refused") throw new Error("expected a refusal");
		expect(outcome.reason).toContain("3 commits this branch does not");
		expect(outcome.reason).toContain("topic has 5 commits");
	});

	it("names the other possibility too, since the refs cannot tell them apart", async () => {
		// A rewritten history and somebody else's push look identical at the ref.
		// Naming only the likelier one would repeat git's own mistake.
		const { exec } = fakeExec(rejected);

		const outcome = await createGitPublisher({ exec }).push(TREE);

		if (outcome.kind !== "refused") throw new Error("expected a refusal");
		expect(outcome.reason).toContain("somebody else pushed");
		// And git's own words are kept, so the evidence is not thrown away.
		expect(outcome.reason).toContain("[rejected]");
	});
});
