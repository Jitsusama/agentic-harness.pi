/**
 * Cutting a carried tree from the person's checkout and taking it out
 * again, through real git: what the cut didn't make is never touched,
 * and a branch is put back only where it still stands where settling
 * left it.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
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

/** The person's checkout, with `topic` one commit past main and `spare` another. */
async function checkout() {
	const origin = await bareOrigin(made);
	const path = await cloneAt(origin, join(folder(made, "src"), "app"));
	const main = await git(path, "rev-parse", "HEAD");
	await git(path, "checkout", "-q", "-b", "topic");
	const topic = await commit(path, "work.txt", "the person's\n");
	await git(path, "checkout", "-q", "-b", "spare", main);
	const spare = await commit(path, "spare.txt", "the person's too\n");
	await git(path, "checkout", "-q", "main");
	return { path, gitDir: join(path, ".git"), main, topic, spare };
}

/** A tree cut at a fresh path for `branch`, as an arrival cuts one. */
async function cut(gitDir: string, name: string, branch = "topic") {
	const at = join(folder(made, "trees"), name);
	const one = await cutFrom(exec, gitDir, at, branch);
	if ("why" in one) throw new Error(one.why);
	return { at, cut: one };
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

/** `exec`, but answering as `answer` for any git call naming `step`. */
function failing(step: string, answer: { code: number; stderr: string }): Exec {
	return (command, args) =>
		args.includes(step)
			? Promise.resolve({ ...answer, stdout: "" })
			: exec(command, args);
}

describe("cutting a tree from the person's checkout", () => {
	it("takes out nothing where git refused the cut", async () => {
		const { gitDir, path, topic } = await checkout();
		const { at } = await cut(gitDir, "taken");

		const again = await cutFrom(exec, gitDir, at, "topic");

		expect(again).toMatchObject({ why: expect.stringMatching(/couldn't cut/) });
		expect(existsSync(join(at, ".git")), "the tree already there stays").toBe(
			true,
		);
		expect(readdirSync(join(gitDir, "worktrees"))).toHaveLength(1);
		expect(await standing(path, "topic")).toBe(topic);
	});

	it.each([
		["git fails", { code: 128, stderr: "fatal: broken\n" }, /fatal: broken$/],
		["git never ran, or was killed", { code: 1, stderr: "" }, /answered 1$/],
	])("refuses the cut where %s listing the branch", async (_, answer, why) => {
		const { gitDir } = await checkout();
		const at = join(folder(made, "trees"), "unread");

		const refused = await cutFrom(
			failing("for-each-ref", answer),
			gitDir,
			at,
			"topic",
		);

		expect(refused).toMatchObject({
			why: expect.stringMatching(/^git couldn't read topic /),
		});
		expect("why" in refused ? refused.why : "").toMatch(why);
		expect(existsSync(at), "nothing was cut").toBe(false);
	});

	it("refuses the cut where the branch's ref can't be read", async () => {
		const { gitDir } = await checkout();
		writeFileSync(join(gitDir, "refs", "heads", "topic"), "not a sha\n");
		const at = join(folder(made, "trees"), "broken");

		const refused = await cutFrom(exec, gitDir, at, "topic");

		expect(refused).toMatchObject({
			why: expect.stringMatching(/couldn't read topic .*broken ref/),
		});
		expect(existsSync(at)).toBe(false);
	});

	it("reads a branch git lists whole without it as none", async () => {
		const { gitDir } = await checkout();

		const { cut: fresh } = await cut(gitDir, "absent", "fresh");

		expect(fresh).toEqual({ checkout: gitDir, before: undefined });
	});
});

describe("taking a cut tree out again", () => {
	it("puts the branch back where settling moved it", async () => {
		const { gitDir, path, main, topic } = await checkout();
		const { at, cut: one } = await cut(gitDir, "moved");
		await git(path, "update-ref", "refs/heads/topic", main);

		const left = await uncut(exec, one, at, "topic", main);

		expect(left).toBeUndefined();
		expect(await standing(path, "topic")).toBe(topic);
		expect(existsSync(at)).toBe(false);
	});

	it("takes out a branch settling made", async () => {
		const { gitDir, path, main } = await checkout();
		const { at, cut: one } = await cut(gitDir, "made", "fresh");
		await git(path, "update-ref", "refs/heads/fresh", main);

		expect(await uncut(exec, one, at, "fresh", main)).toBeUndefined();
		expect(await standing(path, "fresh")).toBeUndefined();
	});

	it("leaves a branch settling never moved, though another brought it to the head", async () => {
		const { gitDir, path, main } = await checkout();
		const { at, cut: one } = await cut(gitDir, "unsettled");
		await git(path, "update-ref", "refs/heads/topic", main);

		expect(await uncut(exec, one, at, "topic", undefined)).toBeUndefined();
		expect(await standing(path, "topic")).toBe(main);
		expect(existsSync(at)).toBe(false);
	});

	it("leaves a branch something else moved meanwhile", async () => {
		const { gitDir, path, main, topic } = await checkout();
		const { at, cut: one } = await cut(gitDir, "raced");
		await git(path, "checkout", "-q", "topic");
		const theirs = await commit(path, "more.txt", "the person's again\n");
		expect(theirs).not.toBe(topic);

		expect(await uncut(exec, one, at, "topic", main)).toBeUndefined();
		expect(await standing(path, "topic"), "their new commit stays").toBe(
			theirs,
		);
	});

	it("leaves a branch moved between reading it and putting it back", async () => {
		const { gitDir, path, main, spare } = await checkout();
		const { at, cut: one } = await cut(gitDir, "racing");
		await git(path, "update-ref", "refs/heads/topic", main);
		const racing: Exec = async (command, args) => {
			if (args.includes("update-ref")) {
				await git(path, "update-ref", "refs/heads/topic", spare);
			}
			return exec(command, args);
		};

		const left = await uncut(racing, one, at, "topic", main);

		expect(left).toMatch(/^its branch topic couldn't be put back in /);
		expect(await standing(path, "topic"), "the move stays").toBe(spare);
	});

	it("leaves a branch it can't read, and says so", async () => {
		const { gitDir, path, main } = await checkout();
		const { at, cut: one } = await cut(gitDir, "unread");
		await git(path, "update-ref", "refs/heads/topic", main);

		const left = await uncut(
			failing("for-each-ref", { code: 1, stderr: "" }),
			one,
			at,
			"topic",
			main,
		);

		expect(left).toMatch(/couldn't be read .*so it was left/);
		expect(await standing(path, "topic"), "left, not deleted").toBe(main);
		expect(existsSync(at), "the tree still goes").toBe(false);
	});

	it("takes out the tree and its own entry where git can't remove it", async () => {
		const { gitDir, path, main, topic } = await checkout();
		const { at, cut: one } = await cut(gitDir, "stuck");
		await git(path, "update-ref", "refs/heads/topic", main);
		const refusing = failing("remove", { code: 128, stderr: "fatal: no\n" });

		expect(await uncut(refusing, one, at, "topic", main)).toBeUndefined();
		expect(existsSync(at)).toBe(false);
		expect(readdirSync(join(gitDir, "worktrees"))).toEqual([]);
		expect(await standing(path, "topic")).toBe(topic);
	});

	it("leaves another tree's entry its .git names, and its branch, saying so", async () => {
		const { gitDir, path, main } = await checkout();
		const { at, cut: one } = await cut(gitDir, "planted");
		const other = await cut(gitDir, "other", "spare");
		const [own, theirs] = [
			await git(at, "rev-parse", "--absolute-git-dir"),
			await git(other.at, "rev-parse", "--absolute-git-dir"),
		];
		writeFileSync(join(at, ".git"), `gitdir: ${theirs}\n`);
		await git(path, "update-ref", "refs/heads/topic", main);
		const refusing = failing("remove", { code: 128, stderr: "fatal: no\n" });

		const left = await uncut(refusing, one, at, "topic", main);

		expect(left).toMatch(
			/^git's entry for the tree cut at .* may be left .*, so its branch topic was left where it stands$/,
		);
		expect(existsSync(theirs), "the other tree's entry stays").toBe(true);
		expect(existsSync(own), "its own entry, unnamed, is said").toBe(true);
		expect(await standing(path, "topic")).toBe(main);
	});
});
