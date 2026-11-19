/**
 * Sweeping the trees a live quest claims only while they are still work,
 * out of a real repository: taken by reclaim's rules once their sessions
 * have ended, but never with work in them that exists nowhere else.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepEndedTrees } from "../../../../lib/core/work/sweep.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	disposeAll,
	elsewhere,
	exec,
	machine,
	machineWithUs,
	settle,
	settleFolder,
	setUp,
} from "../support/sweep-live.ts";

afterEach(disposeAll);

/** Claims holding `paths` only until they are spent. */
const untilSpent = (...paths: string[]) => ({ held: [], untilSpent: paths });

describe("trees a live quest claims until spent", () => {
	it("takes an ended session's merged tree its quest claims, and keeps one held for good", async () => {
		const { cut, sweep } = await setUp();
		const spent = await cut("spent", ["-b", "spent", "@", "main"]);
		const kept = await cut("kept", ["-b", "kept", "@", "main"]);

		const outcome = await sweep({ held: [kept], untilSpent: [spent] });

		// Its branch is at origin's trunk, so it goes with the tree.
		expect(outcome.taken, "what the sweep took").toEqual([
			{ path: spent, branch: "spent", branchGone: true },
		]);
		expect(existsSync(spent), `${spent}, spent, is taken`).toBe(false);
		expect(existsSync(kept), `${kept}, held for good, is kept`).toBe(true);
	});

	it("keeps a claimed tree a live session works in by its own record", async () => {
		// A hosted conversation's folder is no process's working folder, and
		// its tree's record may name only sessions that ended: on 11 November
		// one sweep took such a folder while its host held it open.
		const { cut, sweep } = await setUp();
		const hosted = await cut("hosted", ["-b", "hosted", "@", "main"]);

		const outcome = await sweep(untilSpent(hosted), undefined, {
			sessionFolders: async () => [hosted],
		});

		expect(outcome.taken, "what the sweep took").toEqual([]);
		// Held by the census the sweep began with, so never judged, rather
		// than offered and then kept by the second look.
		const judged = outcome.kept.find((one) => one.path === hosted);
		expect(judged, "the tree was held from the start, not judged").toBe(
			undefined,
		);
		expect(existsSync(hosted), `${hosted}, worked in, is kept`).toBe(true);
	});

	it("keeps a claimed tree a session takes up while the sweep takes another", async () => {
		const { cut, sweep } = await setUp();
		const first = await cut("first", ["-b", "first", "@", "main"]);
		const second = await cut("second", ["-b", "second", "@", "main"]);
		// Nobody in either while both stand, and a conversation in whichever
		// is left once the sweep has taken one, so a look before the takes
		// began can't keep it.
		const outcome = await sweep(untilSpent(first, second), undefined, {
			sessionFolders: async () => {
				const left = [first, second].filter((path) => existsSync(path));
				return left.length === 2 ? [] : left;
			},
		});

		expect(outcome.taken, "what the sweep took").toHaveLength(1);
		const back = [first, second].find((path) => existsSync(path));
		expect(back, "the tree taken up is still there").toBeDefined();
		const why = outcome.kept.find((one) => one.path === back)?.why;
		expect(why, "why the tree was kept").toMatch(/took it up/);
	});

	it("keeps an ended session's claimed tree holding one untracked file", async () => {
		const { cut, sweep } = await setUp();
		const noted = await cut("noted", ["-b", "noted", "@", "main"]);
		writeFileSync(join(noted, "notes.txt"), "written here\n");

		const outcome = await sweep(untilSpent(noted));

		expect(outcome.taken, "what the sweep took").toEqual([]);
		const why = outcome.kept.find((one) => one.path === noted)?.why;
		expect(why, "why the tree was kept").toMatch(/uncommitted changes/);
		expect(existsSync(noted), `${noted}, with a file of its own, is kept`).toBe(
			true,
		);
	});

	it("keeps a claimed tree a stash was made on, at its commit or on its branch, though the tree is clean", async () => {
		const { cut, sweep } = await setUp();
		// A snapshot whose commit trunk holds, stashed at that commit.
		const snap = await cut("snap", ["--detach", "@", "main"]);
		writeFileSync(join(snap, ".gitignore"), "target/\nsnap\n");
		await git(snap, "stash", "-q");
		// A branch stashed on, then moved on, pushed and left a day, which
		// would go but for the stash.
		const moved = await cut("moved", ["-b", "moved", "@", "main"]);
		writeFileSync(join(moved, ".gitignore"), "target/\nmoved\n");
		await git(moved, "stash", "-q");
		await git(moved, "commit", "-q", "--allow-empty", "-m", "on past it");
		await git(moved, "push", "-q", "origin", "moved");
		await settle(moved);

		const outcome = await sweep(untilSpent(snap, moved));

		expect(outcome.taken, "what the sweep took").toEqual([]);
		const why = new Map(outcome.kept.map((one) => [one.path, one.why]));
		expect(why.get(snap), "why the snapshot was kept").toMatch(/stash/);
		expect(why.get(moved), "why the branch was kept").toMatch(/stash/);
	});

	it("takes a claimed snapshot only once a remote holds its commit", async () => {
		const { main, cut, sweep } = await setUp();
		// A commit a session made on a branch it never pushed.
		await git(main, "branch", "-q", "unpushed", "main");
		await git(main, "checkout", "-q", "unpushed");
		await git(main, "commit", "-q", "--allow-empty", "-m", "only here");
		await git(main, "checkout", "-q", "main");
		const local = await cut("local", ["--detach", "@", "unpushed"]);
		const pushed = await cut("pushed", ["--detach", "@", "main"]);

		const outcome = await sweep(untilSpent(local, pushed));

		expect(outcome.taken, "what the sweep took").toEqual([{ path: pushed }]);
		const why = outcome.kept.find((one) => one.path === local)?.why;
		expect(why, "why the snapshot was kept").toMatch(
			/no remote holds the commit it sits at/,
		);
	});

	it("keeps a claimed snapshot that made a commit and went back to a pushed one", async () => {
		const { cut, sweep } = await setUp();
		const back = await cut("back", ["--detach", "@", "main"]);
		await git(back, "commit", "-q", "--allow-empty", "-m", "made here");
		await git(back, "checkout", "-q", "--detach", "main");

		const outcome = await sweep(untilSpent(back));

		expect(outcome.taken, "what the sweep took").toEqual([]);
		const why = outcome.kept.find((one) => one.path === back)?.why;
		expect(why, "why the snapshot was kept").toMatch(/history holds a commit/);
	});

	it("keeps every claimed tree when the stash read never starts", async () => {
		// An exec reports a git that never started as a failure with nothing
		// said, as git saying a ref isn't there once looked.
		const { memory, lockPath, cut } = await setUp();
		const spent = await cut("spent", ["-b", "spent", "@", "main"]);
		const failing = (command: string, args: readonly string[]) =>
			args.includes("refs/stash")
				? Promise.resolve({ code: 1, stdout: "", stderr: "" })
				: exec(command, args);

		const outcome = await sweepEndedTrees({
			exec: failing,
			memory,
			claims: untilSpent(spent),
			lockPath,
			facts: machine,
		});

		expect(outcome.taken, "what the sweep took").toEqual([]);
		const why = outcome.kept.find((one) => one.path === spent)?.why;
		expect(why, "why the tree was kept").toMatch(/stash/);
		expect(existsSync(spent), `${spent} is kept`).toBe(true);
	});

	it("leaves another provider's tree a quest claims until spent held for good", async () => {
		const { memory, lockPath, elsewhereTree } = await setUp();
		const world = elsewhereTree("world");
		settleFolder(world);

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: untilSpent(world),
			lockPath,
			facts: machineWithUs,
			providers: () => [elsewhere(undefined)],
		});

		expect(outcome.taken, "what the sweep took").toEqual([]);
		expect(
			existsSync(world),
			`${world}, its provider calling it spent, is kept`,
		).toBe(true);
	});
});
