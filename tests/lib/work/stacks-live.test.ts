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
	it("fetches trunk into the local ref, then replays onto where it moved", async () => {
		// The failure this verb exists to prevent: a bare fetch updates
		// `origin/main` and leaves `main` where it was, so a restack replays onto
		// a trunk as stale as the one it started on and reports success.
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
		// The local trunk really moved, and the branch really sits on it.
		expect(await subjects(dir, "main")).toContain("their work");
		expect(await subjects(dir, "topic")).toContain("their work");
	});

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
