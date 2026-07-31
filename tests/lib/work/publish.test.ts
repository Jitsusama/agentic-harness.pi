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
import { createGitPublisher } from "../../../lib/work/publish.js";
import { fakeExec } from "../review/support/fake-exec.js";

const TREE = "/trees/topic";

/** A tree on `topic`, tracking `origin/topic`, with an origin remote. */
const tracked = [
	{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
	{
		when: ["rev-parse", "--abbrev-ref", "topic@{upstream}"],
		stdout: "origin/topic\n",
	},
	{ when: ["remote"], stdout: "origin\n" },
	{ when: ["push"], stdout: "", stderr: "To github.com\n" },
];

/** The same tree, on a branch that has never been pushed. */
const untracked = [
	{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
	{ when: ["rev-parse", "--abbrev-ref", "topic@{upstream}"], code: 128 },
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
			{
				when: ["rev-parse", "--abbrev-ref", "topic@{upstream}"],
				stdout: "upstream/topic\n",
			},
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
			...tracked.slice(0, 3),
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

	it("names the remotes it does have when the one asked for is absent", async () => {
		const { exec } = fakeExec([
			{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
			{ when: ["rev-parse", "--abbrev-ref", "topic@{upstream}"], code: 128 },
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
			...tracked.slice(0, 3),
			{ when: ["push"], stdout: "Everything up-to-date\n" },
		]);

		const outcome = await createGitPublisher({ exec }).push(TREE);

		expect(outcome).toMatchObject({ kind: "already-there", branch: "topic" });
	});
});
