/**
 * A stack, against a real repository.
 *
 * The unit tests prove the argv. This proves the argv was the right argv, which
 * is a different claim and the one that keeps turning out to be false here: a
 * fake answers whatever it was told to, so a replay that hands every branch its
 * parent's commits passes a fake and ruins a repository. Four faults in the
 * stack adapter were invisible to a green fake and appeared on the first real
 * repo, which is why this file exists.
 *
 * The stacked repo is built once and copied, the way the shared fixture builds
 * its template, and for the same reason. Building it per test cost about a dozen
 * process spawns each, and spawns are what this suite starves on: a supervisor
 * test elsewhere drives a child process and loses its budget when the machine is
 * busy. A test file that makes an unrelated file flaky is a test file with a bug
 * in it.
 */

import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createGitPublisher,
	createGitRebaser,
	createGitStacks,
	type RestackOutcome,
} from "../../../lib/work/index.js";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.js";

/** An exec over real processes, shaped the way the library expects. */
const exec = (command: string, args: readonly string[]) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
		execFile(command, [...args], (error, stdout, stderr) =>
			done({
				code:
					error === null ? 0 : typeof error.code === "number" ? error.code : 1,
				stdout: stdout ?? "",
				stderr: stderr ?? "",
			}),
		),
	);

function stacksIn() {
	return createGitStacks({ exec, rebaser: createGitRebaser({ exec }) });
}

/**
 * A restack that worked, or a failure that says why it did not.
 *
 * Asserting the kind alone reports "expected 'refused' to be 'restacked'" and
 * throws the reason away, which cost an hour of guessing at a run that failed
 * under load. The library already explains itself; the test only has to not
 * discard the explanation.
 */
async function mustRestack(
	stacks: ReturnType<typeof stacksIn>,
	dir: string,
	trunk: string,
): Promise<Extract<RestackOutcome, { kind: "restacked" }>> {
	const outcome = await stacks.restack(dir, trunk);
	if (outcome.kind === "restacked") return outcome;
	throw new Error(
		`restack answered ${outcome.kind}: ${
			outcome.kind === "refused"
				? outcome.reason
				: outcome.kind === "faulted"
					? outcome.fault.reason
					: `halted at ${outcome.at} over ${outcome.conflicted.join(", ")}`
		}`,
	);
}

const built: string[] = [];
afterEach(() => {
	for (const dir of built.splice(0)) disposeRepo(dir);
});

/** Commit one new file, which is two spawns rather than three. */
async function commitFile(
	dir: string,
	name: string,
	subject: string,
): Promise<void> {
	writeFileSync(join(dir, name), `${name}\n`);
	await git(dir, "add", name);
	await git(dir, "commit", "-qm", subject);
}

/** The memoized stacked template, built at most once per worker. */
let stacked: Promise<string> | undefined;

/**
 * Three branches each on the one below, then trunk moves under all of them.
 *
 * Each branch adds its own file, so a conflict is not what is being tested and a
 * duplicated commit is easy to count.
 */
async function buildStacked(): Promise<string> {
	const dir = await freshRepo("stacked-template");
	for (const name of ["a", "b", "c"]) {
		await git(dir, "checkout", "-qb", name);
		await commitFile(dir, `${name}.txt`, `${name} work`);
	}
	await git(dir, "checkout", "-q", "main");
	await commitFile(dir, "trunk.txt", "trunk moves");
	return dir;
}

/** A private copy of the stacked repo, with nothing tracked yet. */
async function threeHigh(): Promise<string> {
	stacked ??= buildStacked();
	const source = await stacked;
	const dir = mkdtempSync(join(tmpdir(), "stack-"));
	cpSync(source, dir, { recursive: true });
	built.push(dir);
	return dir;
}

/** The same three branches, tracked as a stack. */
async function tracked(): Promise<{
	dir: string;
	stacks: ReturnType<typeof stacksIn>;
}> {
	const dir = await threeHigh();
	const stacks = stacksIn();
	await stacks.track(dir, "a");
	await stacks.track(dir, "b", "a");
	await stacks.track(dir, "c", "b");
	return { dir, stacks };
}

/** Commit subjects on a ref, newest first. */
async function subjects(dir: string, ref: string): Promise<string[]> {
	const said = await git(dir, "log", "--format=%s", ref);
	return said.split("\n").filter((one) => one !== "");
}

describe("a stack in a real repository", () => {
	it("records parentage where git itself will delete it with the branch", async () => {
		const dir = await threeHigh();
		const stacks = stacksIn();

		await stacks.track(dir, "a");
		await stacks.track(dir, "b", "a");

		// Visible to anybody with git, not just to this package.
		expect(await git(dir, "config", "--get", "branch.b.workParent")).toBe("a");

		await git(dir, "branch", "-D", "b");
		expect((await stacks.read(dir)).map((one) => one.name)).not.toContain("b");
	});

	it("replays the whole stack onto trunk without duplicating a commit", async () => {
		// The failure this exists to catch: replaying without the recorded base
		// hands each branch every commit its parent already carries, so `c` ends
		// up with two copies of `b work`.
		const { dir, stacks } = await tracked();

		await mustRestack(stacks, dir, "main");

		const held = await subjects(dir, "c");
		expect(held.filter((one) => one === "b work")).toHaveLength(1);
		expect(held.filter((one) => one === "a work")).toHaveLength(1);
		expect(held).toContain("trunk moves");
	});

	it("leaves each branch sitting on the one below it", async () => {
		const { dir, stacks } = await tracked();

		await mustRestack(stacks, dir, "main");

		// A parent's tip must be an ancestor of its child, which is what makes
		// the stack a stack rather than three branches that happen to exist.
		for (const [parent, child] of [
			["main", "a"],
			["a", "b"],
			["b", "c"],
		]) {
			expect(await git(dir, "branch", "--contains", parent)).toContain(child);
		}
	});

	it("puts the tree back on the branch it started on", async () => {
		const { dir, stacks } = await tracked();
		await git(dir, "checkout", "-q", "b");

		await mustRestack(stacks, dir, "main");

		expect(await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("b");
	});

	it("is a no-op the second time, because the base was recorded", async () => {
		const { dir, stacks } = await tracked();
		await mustRestack(stacks, dir, "main");

		const again = await mustRestack(stacks, dir, "main");

		expect(again.results.every((one) => one.outcome === "already-there")).toBe(
			true,
		);
	});

	it("reorders a stack, and the commits follow after a restack", async () => {
		const { dir, stacks } = await tracked();
		await mustRestack(stacks, dir, "main");

		expect((await stacks.reorder(dir, ["a", "c", "b"])).kind).toBe("shaped");
		await mustRestack(stacks, dir, "main");

		// `b` now sits above `c`, so its history carries c's commit and not the
		// other way round.
		expect(await subjects(dir, "b")).toContain("c work");
		expect(await subjects(dir, "c")).not.toContain("b work");
	});

	it("halts on a real conflict and names the file", async () => {
		const dir = await freshRepo("conflict");
		built.push(dir);
		// Both branches touch the same file, which is what makes a replay stop.
		await git(dir, "checkout", "-qb", "lower");
		await commitFile(dir, "shared.txt", "lower writes");
		await git(dir, "checkout", "-q", "main");
		writeFileSync(join(dir, "shared.txt"), "trunk\n");
		await git(dir, "add", "shared.txt");
		await git(dir, "commit", "-qm", "trunk writes");

		const stacks = stacksIn();
		await stacks.track(dir, "lower");
		const outcome = await stacks.restack(dir, "main");

		expect(outcome.kind).toBe("halted");
		if (outcome.kind !== "halted") return;
		expect(outcome.at).toBe("lower");
		expect(outcome.conflicted).toContain("shared.txt");

		// And the halt is real: git agrees a rebase is in progress, which is what
		// resume and abandon act on.
		const rebaser = createGitRebaser({ exec });
		expect(await rebaser.halted(dir)).toBe(true);
		await rebaser.abandon(dir);
	});
});

describe("publishing against a real remote", () => {
	it("sets upstream the first time, and says so the second", async () => {
		const remote = await freshRepo("remote");
		built.push(remote);
		await git(remote, "config", "core.bare", "true");
		const dir = await freshRepo("local");
		built.push(dir);
		await git(dir, "remote", "add", "origin", remote);
		await git(dir, "checkout", "-qb", "topic");
		await commitFile(dir, "work.txt", "some work");

		const publisher = createGitPublisher({ exec });

		expect(await publisher.push(dir)).toMatchObject({
			kind: "published",
			tracked: true,
		});
		// Git itself confirms the tracking, rather than us believing our argv.
		expect(
			await git(dir, "rev-parse", "--abbrev-ref", "topic@{upstream}"),
		).toBe("origin/topic");
		// A second push with nothing new says so rather than claiming a publish.
		expect(await publisher.push(dir)).toMatchObject({ kind: "already-there" });
	});

	it("refuses a branch with nowhere to go", async () => {
		const dir = await freshRepo("nowhere");
		built.push(dir);

		const outcome = await createGitPublisher({ exec }).push(dir);

		expect(outcome).toMatchObject({ kind: "refused" });
		if (outcome.kind !== "refused") return;
		expect(outcome.reason).toMatch(/remote/);
	});
});

describe("syncing a stack", () => {
	it("replays onto the trunk it just fetched", async () => {
		// The failure this verb exists to prevent: replaying onto a trunk as stale
		// as the one it started on, and reporting success.
		const upstream = await freshRepo("upstream");
		built.push(upstream);
		const dir = await freshRepo("consumer");
		built.push(dir);
		await git(dir, "remote", "add", "origin", upstream);
		await git(dir, "checkout", "-qb", "topic");
		await commitFile(dir, "mine.txt", "my work");
		const stacks = stacksIn();
		await stacks.track(dir, "topic");

		// Somebody else lands on trunk upstream.
		await commitFile(upstream, "theirs.txt", "their work");

		const synced = await stacks.sync(dir, "main");

		expect(synced).toMatchObject({ kind: "synced", moved: true });
		if (synced.kind !== "synced") return;
		expect(synced.replay.kind).toBe("restacked");
		// The fetched trunk really moved, and the branch really sits on it.
		expect(await subjects(dir, "origin/main")).toContain("their work");
		expect(await subjects(dir, "topic")).toContain("their work");
	});

	it("syncs while trunk is checked out in another worktree", async () => {
		// Found by driving the tool, not by this suite, which had trunk checked out
		// nowhere and so never met the refusal. Git will not fetch into a branch
		// that is checked out in any worktree of the repo, and trunk sitting in the
		// primary tree while the work happens in a linked one is the normal
		// arrangement, so the daily verb failed on the commonest layout.
		const upstream = await freshRepo("upstream-shared");
		built.push(upstream);
		const dir = await freshRepo("consumer-shared");
		built.push(dir);
		await git(dir, "remote", "add", "origin", upstream);
		await git(dir, "checkout", "-qb", "topic");
		await commitFile(dir, "mine.txt", "my work");
		const stacks = stacksIn();
		await stacks.track(dir, "topic");

		// A linked worktree holding trunk, which is what blocks the fetch.
		const linked = mkdtempSync(join(tmpdir(), "linked-"));
		built.push(linked);
		await git(dir, "worktree", "add", "-q", linked, "main");

		await commitFile(upstream, "theirs.txt", "their work");

		const synced = await stacks.sync(dir, "main");

		expect(synced).toMatchObject({ kind: "synced", moved: true });
		if (synced.kind !== "synced") return;
		expect(synced.replay.kind).toBe("restacked");
		expect(await subjects(dir, "topic")).toContain("their work");
	}, 30_000);

	it("refuses rather than replaying onto a trunk it could not fetch", async () => {
		// Carrying on would replay onto a stale trunk and call that success.
		const dir = await freshRepo("noremote");
		built.push(dir);
		const stacks = stacksIn();
		await git(dir, "checkout", "-qb", "topic");
		await commitFile(dir, "mine.txt", "my work");
		await stacks.track(dir, "topic");

		const outcome = await stacks.sync(dir, "main");

		expect(outcome).toMatchObject({ kind: "refused" });
		if (outcome.kind !== "refused") return;
		expect(outcome.reason).toContain("nothing was moved");
	});
});

/**
 * A branch and a trunk that each changed the same line differently.
 *
 * Leaves the tree on `topic`, one commit off a `main` that touched the same file,
 * so replaying one onto the other has to stop and ask.
 */
async function conflictingSides(dir: string): Promise<void> {
	writeFileSync(join(dir, "shared.txt"), "from trunk\n", "utf8");
	await git(dir, "add", "shared.txt");
	await git(dir, "commit", "-qm", "trunk writes shared");
	await git(dir, "checkout", "-qb", "topic", "HEAD~1");
	writeFileSync(join(dir, "shared.txt"), "from the branch\n", "utf8");
	await git(dir, "add", "shared.txt");
	await git(dir, "commit", "-qm", "branch writes shared");
}

describe("settling a conflict and carrying on", () => {
	// The test that would have caught a wedged session. `git rebase --continue`
	// finishes a conflicted pick with `git commit -e`, so without the editor
	// turned off git waits for a human on a stdin nobody is attached to. Nothing
	// asserted argv, so nothing noticed; the tool simply never came back, and the
	// tree was left mid-rebase with no verb willing to discuss it.
	//
	// A real conflict is the only way to reach that code. The budget is small on
	// purpose: if the editor ever comes back, this fails in seconds by timeout
	// rather than hanging the suite, and the timeout is the finding.
	it("resumes a halted replay without waiting for an editor", async () => {
		const dir = await freshRepo("resume-conflict");
		built.push(dir);
		const rebaser = createGitRebaser({ exec });

		// Written by hand rather than through commitFile, whose third argument is
		// the commit subject: it always writes the filename as the content, so two
		// sides of a would-be conflict come out byte-identical and git merges them
		// without a murmur. That is correct for the tests it was built for, where a
		// conflict is the thing being avoided.
		await conflictingSides(dir);

		const halted = await rebaser.rebase(dir, "main");
		expect(halted).toMatchObject({ kind: "halted" });
		if (halted.kind !== "halted") return;
		expect(halted.conflicted).toContain("shared.txt");

		writeFileSync(join(dir, "shared.txt"), "settled by hand\n", "utf8");
		await git(dir, "add", "shared.txt");

		const carried = await rebaser.resume(dir);

		expect(carried).toMatchObject({ kind: "replayed" });
		// And the settled content is what landed, rather than either side.
		expect(await git(dir, "show", "HEAD:shared.txt")).toContain("settled");
	}, 30_000);

	it("names the branch when a resume halts again", async () => {
		// A stack halts more than once, and a halt reported from a resume printed no
		// branch: HEAD is detached mid-replay, so every ordinary way of asking which
		// branch you are on answers "HEAD". Git writes it down, so it can be read.
		const dir = await freshRepo("resume-halts-again");
		built.push(dir);
		const rebaser = createGitRebaser({ exec });

		// Two commits on the branch that each touch the contested file, so settling
		// the first conflict runs into a second.
		await conflictingSides(dir);
		writeFileSync(join(dir, "shared.txt"), "and again\n", "utf8");
		await git(dir, "commit", "-qam", "branch writes shared again");

		expect(await rebaser.rebase(dir, "main")).toMatchObject({ kind: "halted" });
		writeFileSync(join(dir, "shared.txt"), "settled once\n", "utf8");
		await git(dir, "add", "shared.txt");

		const again = await rebaser.resume(dir);

		expect(again).toMatchObject({ kind: "halted", branch: "topic" });
		if (again.kind !== "halted") return;
		// The full ref is what git records; a reader wants the branch.
		expect(again.branch).not.toContain("refs/heads");
	}, 30_000);

	it("puts the tree back when a halted replay is abandoned", async () => {
		// The other exit the halt offers. It has to work, or the advice the halt
		// prints is a dead end.
		const dir = await freshRepo("abandon-conflict");
		built.push(dir);
		const rebaser = createGitRebaser({ exec });

		await conflictingSides(dir);
		const before = (await git(dir, "rev-parse", "HEAD")).trim();

		expect(await rebaser.rebase(dir, "main")).toMatchObject({ kind: "halted" });
		const back = await rebaser.abandon(dir);

		expect(back).toMatchObject({ kind: "abandoned" });
		expect((await git(dir, "rev-parse", "HEAD")).trim()).toBe(before);
	}, 30_000);
});

describe("telling a drifted branch from an aligned one", () => {
	// This is the fact a stack is drawn for. Nothing computed it: the renderer had
	// been able to say "needs replaying" since it was written and never once said
	// it, because the only supplier of that answer did not exist. A listing that
	// cannot warn reads exactly like a stack with nothing wrong.
	it("has nothing to say about a tree with no stack recorded", async () => {
		const dir = await threeHigh();

		const standing = await stacksIn().drifted(dir, "main");

		expect(standing).toEqual({ drifted: [], undecided: [] });
	}, 30_000);

	it("names the branch left behind when trunk moves, and only that one", async () => {
		// Trunk moved under the whole stack in the fixture, so the root is behind.
		// Only the root: b sits on a, and a has not moved yet. Asserting the exact
		// list is what makes this a test of the rule rather than of one branch, and
		// it is what caught a first draft of this test that assumed a fresh stack
		// was aligned when the fixture deliberately makes it stale.
		const { dir, stacks } = await tracked();

		const standing = await stacks.drifted(dir, "main");

		expect(standing.drifted).toEqual(["a"]);
		expect(standing.undecided).toEqual([]);
	}, 30_000);

	it("says nothing needs replaying once a restack has run", async () => {
		const { dir, stacks } = await tracked();
		await mustRestack(stacks, dir, "main");

		const standing = await stacks.drifted(dir, "main");

		expect(standing.drifted).toEqual([]);
	}, 30_000);

	it("catches a branch whose parent was reparented under it", async () => {
		// How the gap was found: reparent records where a branch should sit without
		// replaying it, by design, and the listing then drew the new shape as
		// though the commits already matched it.
		const { dir, stacks } = await tracked();
		await mustRestack(stacks, dir, "main");
		await git(dir, "checkout", "-qb", "d", "main");
		await commitFile(dir, "d.txt", "d work");
		await stacks.track(dir, "d");
		await stacks.reparent(dir, "c", "d");

		const standing = await stacks.drifted(dir, "main");

		expect(standing.drifted).toContain("c");
	}, 30_000);

	it("agrees with what a restack then does about each branch", async () => {
		// The two used to be the same comparison written out twice, in two files.
		// Whichever drifted, a restack must replay, or the diagram is a rumour.
		const { dir, stacks } = await tracked();
		const standing = await stacks.drifted(dir, "main");

		const done = await mustRestack(stacks, dir, "main");

		const replayed = done.results
			.filter((one) => one.outcome === "replayed")
			.map((one) => one.branch);
		expect(replayed).toEqual(expect.arrayContaining([...standing.drifted]));
	}, 30_000);

	it("reports a root it cannot judge rather than calling it aligned", async () => {
		// Absent means unreported, not fine. Without a trunk to compare against
		// there is no answer for a root, and inventing the reassuring one is how
		// somebody trusts a stale stack.
		const { dir, stacks } = await tracked();

		const standing = await stacks.drifted(dir);

		expect(standing.undecided).toContain("a");
		expect(standing.drifted).not.toContain("a");
	}, 30_000);
});

describe("a restack that halted and was settled by hand", () => {
	// The worst bug this surface has had, and it took driving the tool to find. The
	// boundary between a branch's commits and its parent's was written only by a
	// restack that ran to completion. A restack that halts is settled by resuming,
	// resume belongs to the rebaser, and the rebaser knows nothing about stacks, so
	// the record stayed as it was before the replay. The next restack then measured
	// the replay from a boundary below its parent's history and handed the branch
	// copies of it, conflicting on each one. That is what it looked like from
	// outside: a restack that conflicted four times over one file against a trunk
	// the branch had already been replayed onto.
	it("does not replay a branch that is already in place", async () => {
		const { dir, stacks } = await tracked();
		// A stale record, exactly as a settled halt used to leave one: the branch
		// genuinely sits on trunk, and the record says it sits further back.
		await mustRestack(stacks, dir, "main");
		await git(
			dir,
			"config",
			"branch.a.workbase",
			await git(dir, "rev-parse", "main~1"),
		);

		const again = await mustRestack(stacks, dir, "main");

		expect(again.results.find((one) => one.branch === "a")).toMatchObject({
			outcome: "already-there",
		});
	}, 30_000);

	it("does not hand a branch copies of its parent's commits", async () => {
		// The consequence the skip prevents, asserted on the commits rather than on
		// the outcome word, because "already-there" is only the right answer if what
		// follows leaves the branch alone.
		const { dir, stacks } = await tracked();
		await mustRestack(stacks, dir, "main");
		const before = await subjects(dir, "a");
		await git(
			dir,
			"config",
			"branch.a.workbase",
			await git(dir, "rev-parse", "main~1"),
		);

		await mustRestack(stacks, dir, "main");

		expect(await subjects(dir, "a")).toEqual(before);
	}, 30_000);

	it("reads alignment from the commits, not from what was written down", async () => {
		const { dir, stacks } = await tracked();
		await mustRestack(stacks, dir, "main");
		await git(
			dir,
			"config",
			"branch.a.workbase",
			await git(dir, "rev-parse", "main~1"),
		);

		const standing = await stacks.drifted(dir, "main");

		expect(standing.drifted).not.toContain("a");
	}, 30_000);

	it("writes the boundary down when a replay is settled outside a restack", async () => {
		// The other half. Reading alignment from the commits stops the damage, but
		// the record is still what a replay is measured from, so it has to be
		// repaired or the next trunk move measures from the wrong place again.
		const { dir, stacks } = await tracked();
		await git(
			dir,
			"config",
			"branch.b.workbase",
			await git(dir, "rev-parse", "main~1"),
		);

		await git(dir, "checkout", "-q", "b");
		await stacks.settled(dir);

		expect(await git(dir, "config", "branch.b.workbase")).toBe(
			await git(dir, "merge-base", "a", "b"),
		);
	}, 30_000);

	it("leaves an untracked branch alone rather than refusing", async () => {
		// Called on the way out of an operation that already succeeded, so it has no
		// standing to fail one.
		const dir = await threeHigh();
		const stacks = stacksIn();

		await expect(stacks.settled(dir, "c")).resolves.toBeUndefined();
	}, 30_000);
});
