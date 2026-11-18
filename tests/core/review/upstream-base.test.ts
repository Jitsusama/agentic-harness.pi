/**
 * Where a local range's base is read: at its upstream's tip when the
 * local branch has only fallen behind it, and as named otherwise. Run
 * against real repositories, a clone tracking an origin, since what is
 * checked is what git says about them.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnExec } from "../../../lib/core/exec/index.ts";
import { upstreamBase } from "../../../lib/core/review/upstream-base.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

let origin: string;
let clone: string;
const exec = spawnExec();

beforeEach(async () => {
	origin = await freshRepo("upstream-origin");
	clone = await freshRepo("upstream-clone");
	disposeRepo(clone);
	await git(origin, "clone", "-q", origin, clone);
	await git(clone, "config", "user.name", "Test");
	// A clone keeps none of its origin's config, so the fixture's own
	// identity, and its signing turned off, are set again here.
	await git(clone, "config", "user.email", "test@example.com");
	await git(clone, "config", "commit.gpgsign", "false");
});

afterEach(() => {
	disposeRepo(origin);
	disposeRepo(clone);
});

async function commit(repo: string, file: string): Promise<string> {
	writeFileSync(join(repo, file), `${file}\n`);
	await git(repo, "add", file);
	await git(repo, "commit", "-q", "-m", `feat: add ${file}`);
	return git(repo, "rev-parse", "HEAD");
}

async function originMoves(by: number): Promise<string> {
	let tip = "";
	for (let at = 0; at < by; at += 1) tip = await commit(origin, `o${at}.ts`);
	await git(clone, "fetch", "-q", "origin");
	return tip;
}

describe("where a range's base is read", () => {
	it("is its upstream's tip when the local branch has only fallen behind", async () => {
		const tip = await originMoves(3);

		expect(await upstreamBase(exec, clone, "main")).toEqual({
			ref: "origin/main",
			commit: tip,
			behind: 3,
		});
	});

	it("is the tracking ref's tip, never a tag or branch of the same short name", async () => {
		const first = await git(clone, "rev-parse", "HEAD");
		const tip = await originMoves(2);
		// A tag of the upstream's short name, which git finds before a
		// remote-tracking ref of the same name.
		await git(clone, "update-ref", "refs/tags/origin/main", first);

		expect(
			(await upstreamBase(exec, clone, "main"))?.commit,
			"the upstream's own tip",
		).toBe(tip);
	});

	it("is the branch as named when it is level with its upstream", async () => {
		expect(await upstreamBase(exec, clone, "main")).toBeUndefined();
	});

	it("is the branch as named when it holds commits its upstream lacks", async () => {
		await originMoves(2);
		await commit(clone, "mine.ts");

		expect(await upstreamBase(exec, clone, "main")).toBeUndefined();
	});

	it("is the branch as named when its upstream already holds the head", async () => {
		const landed = await commit(origin, "landed.ts");
		await originMoves(2);

		expect(
			await upstreamBase(exec, clone, "main", landed),
			"a landed branch reads the commits since the base named",
		).toBeUndefined();
		expect(
			await upstreamBase(exec, clone, "main", "origin/main"),
		).toBeUndefined();
	});

	it("is its upstream's tip when the head is past it, HEAD included", async () => {
		const tip = await originMoves(2);
		await git(clone, "checkout", "-q", "-b", "topic", "origin/main");
		await commit(clone, "topic.ts");

		for (const head of ["topic", "HEAD"]) {
			expect(await upstreamBase(exec, clone, "main", head), head).toEqual({
				ref: "origin/main",
				commit: tip,
				behind: 2,
			});
		}
	});

	it("is the branch as named when it tracks nothing", async () => {
		// Not even where git would set one up for a branch cut from a
		// remote's, as branch.autoSetupMerge may say.
		await git(clone, "branch", "-q", "--no-track", "solo", "origin/main");
		await originMoves(1);

		expect(await upstreamBase(exec, clone, "solo")).toBeUndefined();
	});

	it("is the ref as named when it is no local branch", async () => {
		const tip = await originMoves(1);

		expect(await upstreamBase(exec, clone, "origin/main")).toBeUndefined();
		expect(await upstreamBase(exec, clone, tip)).toBeUndefined();
	});
});
