/**
 * Taking back the snapshots a live session pinned and left, out of a
 * real repository, as the sweep's live tests do.
 */

import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SweepDeps } from "../../../lib/core/work/sweep.ts";
import { sweepEndedTrees } from "../../../lib/core/work/sweep.ts";
import { IDLE_HELD_MS } from "../../../lib/core/work/sweep-idle.ts";
import { git } from "../../support/git-fixture.ts";
import {
	disposeAll,
	exec,
	machine,
	pinnedWhereNoRefHolds,
	RUNNING,
	setUp,
} from "./support/sweep-live.ts";

afterEach(disposeAll);

/** The session a live snapshot's record names, which is still open. */
const OPEN_SESSION = "01open-session";

/** Past the idle window by a minute. */
const IDLE = IDLE_HELD_MS + 60_000;

/** An hour, in milliseconds. */
const HOUR = 60 * 60 * 1000;

type Setup = Awaited<ReturnType<typeof setUp>>;

/**
 * A snapshot pinned by {@link RUNNING}, a session still open, left
 * alone `ago` milliseconds: its record's use, its folder and its git, as
 * a review that asked for it, read it and ended leaves it.
 */
async function leftAlone(
	setup: Setup,
	name: string,
	ago: number,
): Promise<{ tree: string; commit: string }> {
	const tree = join(setup.state, name);
	const commit = await pinnedWhereNoRefHolds(setup.main, setup.memory, tree, [
		RUNNING,
	]);
	const record = setup.memory.recall().find((one) => one.path === tree);
	if (record === undefined) throw new Error(`${tree} has no record`);
	setup.memory.remember({
		...record,
		sessions: [OPEN_SESSION],
		usedAt: Date.now() - ago,
		datedBy: record.owners,
	});
	await untouchedFor(tree, ago);
	return { tree, commit };
}

/** The files git moves in a tree as it is used. */
async function movedByGit(tree: string): Promise<string[]> {
	const gitDir = (await git(tree, "rev-parse", "--absolute-git-dir")).trim();
	return ["HEAD", "index", join("logs", "HEAD")].map((one) =>
		join(gitDir, one),
	);
}

/** Put a tree's folder and the files its git moves `ago` milliseconds back. */
async function untouchedFor(tree: string, ago: number): Promise<void> {
	const then = new Date(Date.now() - ago);
	for (const one of await movedByGit(tree)) utimesSync(one, then, then);
	utimesSync(tree, then, then);
}

/** Change a tree's record as `change` says. */
function rewrite(
	setup: Setup,
	tree: string,
	change: (record: NonNullable<ReturnType<typeof find>>) => object,
): void {
	const record = find(setup, tree);
	if (record === undefined) throw new Error(`${tree} has no record`);
	setup.memory.remember({ ...record, ...change(record) });
}

/** A tree's record, if it has one. */
function find(setup: Setup, tree: string) {
	return setup.memory.recall().find((one) => one.path === tree);
}

/**
 * Sweep where the open session is live and nothing works in any tree,
 * told what `known` says besides.
 */
function sweepWhileOpen(
	setup: Setup,
	known: Partial<Pick<SweepDeps, "busyAmong" | "claims">> = {},
) {
	return sweepEndedTrees({
		exec,
		memory: setup.memory,
		claims: [],
		lockPath: setup.lockPath,
		facts: machine,
		liveSessions: async () => new Set([OPEN_SESSION]),
		busyAmong: async () => new Set(),
		...known,
	});
}

describe("taking the snapshots a live session pinned and left", () => {
	it("takes one an open session left unused past the idle window, saying whose and at what", async () => {
		const setup = await setUp();
		const { tree, commit } = await leftAlone(setup, "left", IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([
			{
				path: tree,
				sessions: [OPEN_SESSION],
				commit,
				why: "unused for 4 h while its session stayed open",
			},
		]);
		expect(existsSync(tree), `${tree} is still there`).toBe(false);
		expect(setup.memory.recall().map((one) => one.path)).not.toContain(tree);
	});

	it("keeps one a session asked for within the window, though its files sat still", async () => {
		const setup = await setUp();
		const { tree } = await leftAlone(setup, "asked", IDLE);
		rewrite(setup, tree, () => ({ usedAt: Date.now() - HOUR }));

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken, "a snapshot used an hour ago was taken").toEqual([]);
		expect(existsSync(tree), "a snapshot used an hour ago went").toBe(true);
	});

	it("keeps one whose git moved within the window, though its folder sat still", async () => {
		const setup = await setUp();
		const { tree } = await leftAlone(setup, "read", IDLE);
		const then = new Date(Date.now() - 3 * HOUR);
		for (const one of await movedByGit(tree)) utimesSync(one, then, then);

		const outcome = await sweepWhileOpen(setup);

		expect(
			outcome.taken,
			"a snapshot git moved in three hours ago was taken",
		).toEqual([]);
		expect(existsSync(tree), "a snapshot git moved in went").toBe(true);
	});

	it("keeps one whose folder changed within the window, though its git sat still", async () => {
		const setup = await setUp();
		const { tree } = await leftAlone(setup, "built", IDLE);
		const then = new Date(Date.now() - 3 * HOUR);
		utimesSync(tree, then, then);

		const outcome = await sweepWhileOpen(setup);

		expect(
			outcome.taken,
			"a snapshot changed three hours ago was taken",
		).toEqual([]);
		expect(existsSync(tree), "a snapshot changed three hours ago went").toBe(
			true,
		);
	});

	it("keeps an idle one with a file nobody committed, or one staged, without trying to remove it", async () => {
		const setup = await setUp();
		const noted = (await leftAlone(setup, "noted", IDLE)).tree;
		writeFileSync(join(noted, "notes.txt"), "written here\n");
		await untouchedFor(noted, IDLE);
		const staged = (await leftAlone(setup, "staged", IDLE)).tree;
		writeFileSync(join(staged, "change.txt"), "staged here\n");
		await git(staged, "add", "change.txt");
		await untouchedFor(staged, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken, "a snapshot holding work was taken").toEqual([]);
		// Git refuses to remove a tree holding work, so one that got as far
		// as a removal would be kept by git, not by the choosing.
		expect(
			outcome.refused.map((one) => one.path),
			"a snapshot holding work was chosen, and kept only by git",
		).toEqual([]);
		expect(
			existsSync(join(noted, "notes.txt")),
			"an uncommitted file went",
		).toBe(true);
		expect(existsSync(join(staged, "change.txt")), "a staged file went").toBe(
			true,
		);
	});

	it("keeps an idle one with a commit made there, whether left at HEAD or only in its reflog", async () => {
		const setup = await setUp();
		const ahead = await leftAlone(setup, "ahead", IDLE);
		await git(ahead.tree, "commit", "-q", "--allow-empty", "-m", "made here");
		await untouchedFor(ahead.tree, IDLE);
		const back = await leftAlone(setup, "back", IDLE);
		await git(back.tree, "commit", "-q", "--allow-empty", "-m", "made here");
		await git(back.tree, "checkout", "-q", "--detach", back.commit);
		await untouchedFor(back.tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(
			outcome.taken,
			"a snapshot with a commit made in it was taken",
		).toEqual([]);
		expect(existsSync(ahead.tree), "a tree with a commit at HEAD went").toBe(
			true,
		);
		expect(
			existsSync(back.tree),
			"a tree with a commit only its reflog holds went",
		).toBe(true);
	});

	it("keeps an idle one something claims, or whose record names nobody", async () => {
		const setup = await setUp();
		const claimed = (await leftAlone(setup, "claimed", IDLE)).tree;
		const nobody = (await leftAlone(setup, "nobody", IDLE)).tree;
		rewrite(setup, nobody, () => ({ owners: [] }));

		const outcome = await sweepWhileOpen(setup, { claims: [claimed] });

		expect(
			outcome.taken.map((one) => one.path),
			"a claimed snapshot, or one nobody holds, was taken as idle",
		).toEqual([]);
		expect(existsSync(claimed), "a claimed tree went").toBe(true);
		expect(existsSync(nobody), "a tree whose record names nobody went").toBe(
			true,
		);
	});

	it("keeps an idle one a process came to work in while the sweep chose, leaving its index alone", async () => {
		const setup = await setUp();
		const worked = (await leftAlone(setup, "worked", IDLE)).tree;
		const free = (await leftAlone(setup, "free", IDLE)).tree;
		const [, index] = await movedByGit(worked);
		const before = statSync(index ?? "").mtimeMs;
		const asked: string[][] = [];

		const outcome = await sweepWhileOpen(setup, {
			// Free at the first reading, so its git is read; busy at the
			// second, just before the take.
			busyAmong: async (paths) => {
				asked.push([...paths].sort());
				return new Set(
					asked.length > 1 ? paths.filter((path) => path === worked) : [],
				);
			},
		});

		expect(
			asked,
			"what processes hold wasn't read of every aged tree, then again of those chosen",
		).toEqual([[free, worked].sort(), [free, worked].sort()]);
		expect(outcome.taken.map((one) => one.path)).toEqual([free]);
		expect(existsSync(worked), "a tree a process works in went").toBe(true);
		expect(
			statSync(index ?? "").mtimeMs,
			"judging a snapshot rewrote its index, marking it used",
		).toBe(before);
	});

	it("never chooses one a process works in at the first reading, so it fills none of the takes", async () => {
		const setup = await setUp();
		const worked = (await leftAlone(setup, "worked", IDLE)).tree;
		const free = (await leftAlone(setup, "free", IDLE)).tree;
		const asked: string[][] = [];

		const outcome = await sweepWhileOpen(setup, {
			busyAmong: async (paths) => {
				asked.push([...paths].sort());
				return new Set(paths.filter((path) => path === worked));
			},
		});

		expect(
			asked[1],
			"a tree busy at the first reading was among those chosen",
		).toEqual([free]);
		expect(outcome.taken.map((one) => one.path)).toEqual([free]);
		expect(existsSync(worked), "a tree a process works in went").toBe(true);
	});

	it("keeps one whose folder moved after the choosing, judged again under its record's lock", async () => {
		const setup = await setUp();
		const { tree } = await leftAlone(setup, "touched", IDLE);
		let readings = 0;

		const outcome = await sweepWhileOpen(setup, {
			// Something works there between the last reading and the take.
			busyAmong: async () => {
				readings += 1;
				if (readings === 2) {
					const now = new Date();
					utimesSync(tree, now, now);
				}
				return new Set();
			},
		});

		expect(
			outcome.taken,
			"a snapshot used after it was chosen was taken",
		).toEqual([]);
		expect(existsSync(tree), "a snapshot used after it was chosen went").toBe(
			true,
		);
	});

	it("takes none where the machine can't say what processes hold", async () => {
		const setup = await setUp();
		const { tree } = await leftAlone(setup, "unknown", IDLE);

		const outcome = await sweepWhileOpen(setup, {
			busyAmong: async () => undefined,
		});

		expect(outcome.taken, "a snapshot was taken blind").toEqual([]);
		expect(
			existsSync(tree),
			"a tree went with nothing to say it was free",
		).toBe(true);
	});

	it("keeps one held by a session whose asks don't date its use, as one on older code", async () => {
		// Older code writes back the record it read, its date stale or
		// gone, and adds itself as an owner without saying its asks date it.
		const setup = await setUp();
		const joined = (await leftAlone(setup, "joined", IDLE)).tree;
		rewrite(setup, joined, (record) => ({
			owners: [...(record.owners ?? []), { pid: 4003, startedAt: 3000 }],
		}));
		const undated = (await leftAlone(setup, "undated", IDLE)).tree;
		const record = find(setup, undated);
		if (record === undefined) throw new Error(`${undated} has no record`);
		const { datedBy: _, ...withoutDating } = record;
		setup.memory.remember(withoutDating);

		const outcome = await sweepWhileOpen(setup);

		expect(
			outcome.taken,
			"a snapshot an older session may be using was taken",
		).toEqual([]);
		expect(existsSync(joined), "a tree an older session joined went").toBe(
			true,
		);
		expect(existsSync(undated), "a tree whose use went undated went").toBe(
			true,
		);
	});
});
