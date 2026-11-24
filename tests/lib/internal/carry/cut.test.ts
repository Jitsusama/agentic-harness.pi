/**
 * Cutting a carried tree from the person's checkout and taking it out
 * again, through real git: what the cut didn't make is never touched,
 * and a branch is put back only where it still stands where settling
 * left it.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import { cutFrom, uncut } from "../../../../lib/internal/carry/cut.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	bareOrigin,
	cloneAt,
	commit,
	exec,
	folder,
	removeAll,
} from "./support/machines.ts";

const made: string[] = [];
afterEach(() => removeAll(made));

/** The person's checkout, with `topic` one commit past main. */
async function checkout() {
	const origin = await bareOrigin(made);
	const path = await cloneAt(origin, join(folder(made, "src"), "app"));
	const main = await git(path, "rev-parse", "HEAD");
	await git(path, "checkout", "-q", "-b", "topic");
	const topic = await commit(path, "work.txt", "the person's\n");
	await git(path, "checkout", "-q", "main");
	return { path, gitDir: join(path, ".git"), main, topic };
}

/** Where `branch` stands in the checkout at `path`, or none. */
async function standing(path: string, branch: string) {
	const said = await exec("git", [
		"-C",
		path,
		"rev-parse",
		"--verify",
		"-q",
		`refs/heads/${branch}`,
	]);
	return said.code === 0 ? said.stdout.trim() : undefined;
}

/** `exec`, but answering `code` for any rev-parse, as a broken git does. */
function revParseFails(code: number): Exec {
	return (command, args) =>
		args.includes("rev-parse")
			? Promise.resolve({ code, stdout: "", stderr: "fatal: broken\n" })
			: exec(command, args);
}

describe("cutting a tree from the person's checkout", () => {
	it("takes out nothing where git refused the cut", async () => {
		const { gitDir, path } = await checkout();
		const at = join(folder(made, "trees"), "taken");
		const theirs = await cutFrom(exec, gitDir, at, "topic");
		expect("why" in theirs).toBe(false);

		const again = await cutFrom(exec, gitDir, at, "topic");

		expect(again).toMatchObject({ why: expect.stringMatching(/couldn't cut/) });
		expect(existsSync(join(at, ".git")), "the tree already there stays").toBe(
			true,
		);
		expect(readdirSync(join(gitDir, "worktrees"))).toHaveLength(1);
		expect(await standing(path, "topic")).toBeDefined();
	});

	it("refuses the cut where git can't say whether the branch is there", async () => {
		const { gitDir } = await checkout();
		const at = join(folder(made, "trees"), "unread");

		const cut = await cutFrom(revParseFails(128), gitDir, at, "topic");

		expect(cut).toMatchObject({
			why: expect.stringMatching(/couldn't read topic .*fatal: broken$/),
		});
		expect(existsSync(at), "nothing was cut").toBe(false);
	});

	it("reads only git's 1 as no branch", async () => {
		const { gitDir } = await checkout();
		const at = join(folder(made, "trees"), "absent");

		const cut = await cutFrom(revParseFails(1), gitDir, at, "topic");

		expect(cut).toMatchObject({ checkout: gitDir, before: undefined });
	});
});

describe("taking a cut tree out again", () => {
	it("puts the branch back where settling moved it", async () => {
		const { gitDir, path, main, topic } = await checkout();
		const at = join(folder(made, "trees"), "moved");
		const cut = await cutFrom(exec, gitDir, at, "topic");
		if ("why" in cut) throw new Error(cut.why);
		await git(path, "update-ref", "refs/heads/topic", main);

		const left = await uncut(exec, cut, at, "topic", main);

		expect(left).toBeUndefined();
		expect(await standing(path, "topic")).toBe(topic);
		expect(existsSync(at)).toBe(false);
	});

	it("takes out a branch settling made", async () => {
		const { gitDir, path, main } = await checkout();
		const at = join(folder(made, "trees"), "made");
		const cut = await cutFrom(exec, gitDir, at, "fresh");
		if ("why" in cut) throw new Error(cut.why);
		await git(path, "update-ref", "refs/heads/fresh", main);

		expect(await uncut(exec, cut, at, "fresh", main)).toBeUndefined();
		expect(await standing(path, "fresh")).toBeUndefined();
	});

	it("leaves a branch something else moved meanwhile", async () => {
		const { gitDir, path, main, topic } = await checkout();
		const at = join(folder(made, "trees"), "raced");
		const cut = await cutFrom(exec, gitDir, at, "topic");
		if ("why" in cut) throw new Error(cut.why);
		await git(path, "checkout", "-q", "topic");
		const theirs = await commit(path, "more.txt", "the person's again\n");
		expect(theirs).not.toBe(topic);

		expect(await uncut(exec, cut, at, "topic", main)).toBeUndefined();
		expect(await standing(path, "topic"), "their new commit stays").toBe(
			theirs,
		);
	});

	it("leaves a branch it can't read, and says so", async () => {
		const { gitDir, path, main } = await checkout();
		const at = join(folder(made, "trees"), "unread");
		const cut = await cutFrom(exec, gitDir, at, "topic");
		if ("why" in cut) throw new Error(cut.why);
		await git(path, "update-ref", "refs/heads/topic", main);

		const left = await uncut(revParseFails(128), cut, at, "topic", main);

		expect(left).toMatch(/couldn't be read .*so it was left/);
		expect(await standing(path, "topic"), "left, not deleted").toBe(main);
		expect(existsSync(at), "the tree still goes").toBe(false);
	});
});
