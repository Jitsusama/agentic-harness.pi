/**
 * A stack, against a real repository.
 *
 * The unit tests prove the argv. This proves the argv was the right argv, which
 * is a different claim and the one that has repeatedly turned out to be false
 * here: a fake answers whatever it was told to, so a replay that duplicates
 * every commit its parent carries passes a fake and ruins a repository.
 *
 * So this builds three branches, moves trunk under them, restacks, and counts
 * the commits. A duplicated commit is the specific failure worth a real repo.
 */

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRebaser } from "../../../lib/work/rebase.js";
import {
	createGitStacks,
	type RestackOutcome,
} from "../../../lib/work/stacks.js";
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

afterEach(async () => {
	for (const dir of built.splice(0)) await disposeRepo(dir);
});

/**
 * Three branches stacked on each other, then trunk moves under all of them.
 *
 * Each branch adds its own file, so a conflict is not what is being tested and
 * a duplicated commit is easy to count.
 */
async function threeHigh(): Promise<string> {
	const dir = await freshRepo("stack");
	built.push(dir);
	for (const name of ["a", "b", "c"]) {
		await git(dir, "checkout", "-qb", name);
		writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
		await git(dir, "add", `${name}.txt`);
		await git(dir, "commit", "-qm", `${name} work`);
	}
	await git(dir, "checkout", "-q", "main");
	writeFileSync(join(dir, "trunk.txt"), "moved\n");
	await git(dir, "add", "trunk.txt");
	await git(dir, "commit", "-qm", "trunk moves");
	return dir;
}

/** Commit subjects on a branch, newest first. */
async function log(dir: string, ref: string): Promise<string[]> {
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
		const said = await git(dir, "config", "--get", "branch.b.workParent");
		expect(said).toBe("a");

		await git(dir, "branch", "-D", "b");
		const after = await stacks.read(dir);
		expect(after.map((one) => one.name)).not.toContain("b");
	});

	it("replays the whole stack onto trunk without duplicating a commit", async () => {
		// The failure this exists to catch: replaying without the recorded base
		// hands each branch every commit its parent already carries, so `c`
		// ends up with two copies of `b work`.
		const dir = await threeHigh();
		const stacks = stacksIn();
		await stacks.track(dir, "a");
		await stacks.track(dir, "b", "a");
		await stacks.track(dir, "c", "b");

		await mustRestack(stacks, dir, "main");

		const subjects = await log(dir, "c");
		expect(subjects.filter((one) => one === "b work")).toHaveLength(1);
		expect(subjects.filter((one) => one === "a work")).toHaveLength(1);
		// And trunk's commit is now underneath all of it.
		expect(subjects).toContain("trunk moves");
	});

	it("leaves each branch sitting on the one below it", async () => {
		const dir = await threeHigh();
		const stacks = stacksIn();
		await stacks.track(dir, "a");
		await stacks.track(dir, "b", "a");
		await stacks.track(dir, "c", "b");

		await mustRestack(stacks, dir, "main");

		// A parent's tip must be an ancestor of its child, which is what makes
		// the stack a stack rather than three branches that happen to exist.
		for (const [parent, child] of [
			["main", "a"],
			["a", "b"],
			["b", "c"],
		]) {
			const merged = await git(dir, "branch", "--contains", parent);
			expect(merged).toContain(child);
		}
	});

	it("puts the tree back on the branch it started on", async () => {
		const dir = await threeHigh();
		const stacks = stacksIn();
		await stacks.track(dir, "a");
		await stacks.track(dir, "b", "a");
		await git(dir, "checkout", "-q", "b");

		await stacks.restack(dir, "main");

		expect(await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("b");
	});

	it("is a no-op the second time, because the base was recorded", async () => {
		const dir = await threeHigh();
		const stacks = stacksIn();
		await stacks.track(dir, "a");
		await stacks.track(dir, "b", "a");
		await stacks.restack(dir, "main");

		const again = await stacks.restack(dir, "main");

		if (again.kind !== "restacked") throw new Error("expected a restack");
		expect(again.results.every((one) => one.outcome === "already-there")).toBe(
			true,
		);
	});

	it("reorders a stack, and the commits follow after a restack", async () => {
		const dir = await threeHigh();
		const stacks = stacksIn();
		await stacks.track(dir, "a");
		await stacks.track(dir, "b", "a");
		await stacks.track(dir, "c", "b");
		await stacks.restack(dir, "main");

		const shaped = await stacks.reorder(dir, ["a", "c", "b"]);
		expect(shaped.kind).toBe("shaped");
		await stacks.restack(dir, "main");

		// `b` now sits above `c`, so its history carries c's commit and not the
		// other way round.
		expect(await log(dir, "b")).toContain("c work");
		expect(await log(dir, "c")).not.toContain("b work");
	});

	it("halts on a real conflict and names the file", async () => {
		const dir = await freshRepo("conflict");
		built.push(dir);
		// Both branches touch the same line, which is what makes a replay stop.
		await git(dir, "checkout", "-qb", "lower");
		writeFileSync(join(dir, "shared.txt"), "lower\n");
		await git(dir, "add", "shared.txt");
		await git(dir, "commit", "-qm", "lower writes");
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

		// And the halt is real: git agrees a rebase is in progress, which is
		// what resume and abandon act on.
		expect(await createGitRebaser({ exec }).halted(dir)).toBe(true);
		await createGitRebaser({ exec }).abandon(dir);
	});
});
