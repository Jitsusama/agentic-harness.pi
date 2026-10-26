/**
 * A published branch tracks itself, and its lease has a ref to read.
 *
 * A branch cut from `origin/main` tracks main, and publishing it left it
 * so. In a checkout whose fetch covers only a few branches, the push also
 * wrote no tracking ref for the branch, so every later lease was refused
 * as stale, saying the remote had moved when nothing had. Run against real
 * git, since both faults are what git does with its own configuration.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnExec } from "../../../lib/core/exec/index.ts";
import { createGitPublisher } from "../../../lib/core/work/publish.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

let place: string;
let clone: string;

beforeEach(async () => {
	place = await freshRepo("publish-tracking");
	const origin = join(place, "origin.git");
	clone = join(place, "clone");
	await git(place, "clone", "-q", "--bare", place, origin);
	await git(place, "clone", "-q", origin, clone);
	await git(clone, "config", "user.email", "test@example.com");
	await git(clone, "config", "user.name", "Test");
	await git(clone, "config", "commit.gpgsign", "false");
});

afterEach(() => {
	disposeRepo(place);
});

/** A branch cut from origin/main with one commit on it. */
async function branchFromMain(name: string): Promise<void> {
	await git(clone, "checkout", "-q", "-b", name, "refs/remotes/origin/main");
	writeFileSync(join(clone, "work.txt"), "first\n");
	await git(clone, "add", "work.txt");
	await git(clone, "commit", "-qm", "work");
}

/** The same commit made again, as a rebase or an amend leaves it. */
async function rewrite(): Promise<void> {
	writeFileSync(join(clone, "work.txt"), "second\n");
	await git(clone, "add", "work.txt");
	await git(clone, "commit", "-q", "--amend", "-m", "work, again");
}

describe.each([
	["a checkout that fetches every branch", false],
	["a checkout that fetches only main", true],
])("publishing a branch cut from origin/main, in %s", (_, narrow) => {
	beforeEach(async () => {
		if (narrow) {
			await git(
				clone,
				"config",
				"remote.origin.fetch",
				"+refs/heads/main:refs/remotes/origin/main",
			);
		}
	});

	it("tracks its own branch from then on, not main", async () => {
		await branchFromMain("jg/topic");

		const outcome = await createGitPublisher({ exec: spawnExec() }).push(clone);

		expect(outcome).toMatchObject({ kind: "published", tracked: true });
		expect(
			await git(clone, "rev-parse", "--abbrev-ref", "jg/topic@{upstream}"),
		).toBe("origin/jg/topic");
		expect(await git(clone, "rev-parse", "refs/remotes/origin/jg/topic")).toBe(
			await git(clone, "rev-parse", "jg/topic"),
		);
		// A fetch that already covered it is left as it was; a narrow one
		// gains this branch and no other.
		expect(
			(await git(clone, "config", "--get-all", "remote.origin.fetch")).split(
				"\n",
			),
		).toEqual(
			narrow
				? [
						"+refs/heads/main:refs/remotes/origin/main",
						"+refs/heads/jg/topic:refs/remotes/origin/jg/topic",
					]
				: ["+refs/heads/*:refs/remotes/origin/*"],
		);
	});

	it("replaces it with a lease once rewritten, since nothing else moved", async () => {
		await branchFromMain("jg/topic");
		const publisher = createGitPublisher({ exec: spawnExec() });
		await publisher.push(clone);
		await rewrite();

		const outcome = await publisher.push(clone, { replace: true });

		expect(outcome).toMatchObject({ kind: "published", replaced: true });
	});
});

describe("publishing beside a local branch named like origin's", () => {
	it("reads the remote from the branch's settings, not its upstream's short name", async () => {
		// A local origin/main beside origin's own makes git spell the upstream
		// remotes/origin/main to keep it apart, and the push read `remotes` as
		// the remote: "This tree has no remote called remotes, only origin".
		await git(clone, "branch", "origin/main", "refs/remotes/origin/main");
		await branchFromMain("jg/topic");
		expect(
			await git(clone, "rev-parse", "--abbrev-ref", "jg/topic@{upstream}"),
		).toBe("remotes/origin/main");

		const outcome = await createGitPublisher({ exec: spawnExec() }).push(clone);

		expect(outcome).toMatchObject({ kind: "published", tracked: true });
		expect(await git(clone, "config", "--get", "branch.jg/topic.merge")).toBe(
			"refs/heads/jg/topic",
		);
		expect(await git(clone, "rev-parse", "refs/remotes/origin/jg/topic")).toBe(
			await git(clone, "rev-parse", "jg/topic"),
		);
	});
});
