/**
 * git run in a tree as arrive runs it, through real git and sh: fed its
 * input, and stopped once a call to a remote runs past its time. And a
 * tree's origin branches held to an origin that moves under it.
 */

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	gitIn,
	holdToOrigin,
	type ViewGit,
} from "../../../../lib/internal/carry/origin-view.ts";
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

/** A tree with nothing in it, for git to run in. */
async function tree(): Promise<string> {
	const path = folder(made, "view");
	await git(path, "init", "-q");
	return path;
}

/** A remote that takes the call and never answers, over git's ext. */
const SILENT = ["-c", "protocol.ext.allow=always"];

/** The folders fed input leaves in the tree's .git, which go with it. */
function inputsLeft(path: string): string[] {
	return readdirSync(join(path, ".git")).filter((name) =>
		name.startsWith("carry-in-"),
	);
}

describe("git in a tree, as arrive runs it", () => {
	it("stops a remote that never answers once its time is up, saying so", async () => {
		const path = await tree();
		const started = Date.now();

		const done = await gitIn(exec, path)
			.within(1)
			.run(...SILENT, "ls-remote", "ext::sh -c sleep% 30");

		expect(done.code).not.toBe(0);
		expect(done.stderr).toMatch(/^git was stopped after 1 seconds\./);
		expect(Date.now() - started, "well before the remote would").toBeLessThan(
			15_000,
		);
	});

	it("stops a fed fetch from a remote that never answers, leaving no input behind", async () => {
		const path = await tree();
		const started = Date.now();

		const done = await gitIn(exec, path)
			.within(1)
			.fed(
				["+refs/heads/main:refs/remotes/origin/main"],
				...SILENT,
				"fetch",
				"--stdin",
				"ext::sh -c sleep% 30",
			);

		expect(done.code).not.toBe(0);
		expect(done.stderr).toMatch(/^git was stopped after 1 seconds\./);
		expect(Date.now() - started, "well before the remote would").toBeLessThan(
			15_000,
		);
		expect(inputsLeft(path), "its input is gone").toEqual([]);
	});

	it("lets git that ends in its time say what it said", async () => {
		const path = await tree();

		const done = await gitIn(exec, path)
			.within(30)
			.fed(["one", "two"], "hash-object", "--stdin");

		expect(done.code).toBe(0);
		expect(done.stdout.trim(), "the blob of its lines, each ended").toBe(
			createHash("sha1").update("blob 8\0one\ntwo\n").digest("hex"),
		);
	});
});

describe("holding a tree's origin branches to origin", () => {
	it("takes the trunk from origin though origin drops another branch after listing it", async () => {
		const origin = await bareOrigin(made);
		const work = await cloneAt(origin, join(folder(made, "work"), "w"));
		await git(work, "push", "-q", "origin", "main:race");
		const path = await cloneAt(origin, join(folder(made, "tree"), "t"));
		const was = await git(path, "rev-parse", "origin/race");
		const main = await commit(work, "main.txt", "past the tree\n");
		await git(work, "checkout", "-q", "-b", "race");
		await commit(work, "race.txt", "past the tree too\n");
		await git(work, "push", "-q", "origin", "main", "race");
		const listedThenDropped: ViewGit = {
			...gitIn(exec, path),
			within: (seconds) => {
				const timed = gitIn(exec, path).within(seconds);
				return {
					...timed,
					run: async (...args) => {
						const listed = await timed.run(...args);
						if (args.includes("ls-remote")) {
							await git(origin, "branch", "-q", "-D", "race");
						}
						return listed;
					},
				};
			},
		};

		const held = await holdToOrigin(listedThenDropped);

		expect(held.why).toBeUndefined();
		expect(await git(path, "rev-parse", "refs/remotes/origin/main")).toBe(main);
		const refs = await git(path, "for-each-ref", "--format=%(refname)");
		expect(refs, "the trunk claims origin's, not aside").not.toContain(
			"refs/carry/twin/main",
		);
		expect(refs).not.toContain("refs/remotes/origin/race");
		expect(await git(path, "rev-parse", "refs/carry/twin/race")).toBe(was);
		expect(held.unsure).toMatch(
			/^1 of origin's branches past the twin didn't come, so they wait under refs\/carry\/twin\/: race\. /,
		);
		expect(inputsLeft(path)).toEqual([]);
	});
});
