/**
 * Taking back the snapshots a live session pinned and left, out of a
 * real repository, as the sweep's live tests do. How it chooses them,
 * against git's answers made up, is in `sweep-idle-choosing.test.ts`.
 */

import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HeldTree } from "../../../../lib/core/work/broker.ts";
import type { SweepDeps } from "../../../../lib/core/work/sweep.ts";
import { sweepEndedTrees } from "../../../../lib/core/work/sweep.ts";
import {
	IDLE_HELD_MS,
	IDLE_TAKES_PER_SWEEP,
} from "../../../../lib/core/work/sweep-idle.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	disposeAll,
	elsewhere,
	exec,
	machine,
	machineWithUs,
	pinnedWhereNoRefHolds,
	RUNNING,
	settleFolder,
	setUp,
} from "../support/sweep-live.ts";

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
	});
	recordWritten(setup, record, ago);
	await untouchedFor(tree, ago);
	return { tree, commit };
}

/** Date a tree's record file `ago` milliseconds back, as its last ask. */
function recordWritten(setup: Setup, record: HeldTree, ago: number): void {
	const file = join(
		setup.state,
		"cut",
		`${record.identity.key.replaceAll("/", "-")}.json`,
	);
	const then = new Date(Date.now() - ago);
	utimesSync(file, then, then);
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

/**
 * Change a tree's record as `change` says, leaving its file dated as it
 * was, as no ask wrote it.
 */
function rewrite(
	setup: Setup,
	tree: string,
	change: (record: NonNullable<ReturnType<typeof find>>) => object,
): void {
	const record = find(setup, tree);
	if (record === undefined) throw new Error(`${tree} has no record`);
	const asked = setup.memory.askedAt(tree) ?? Date.now();
	setup.memory.remember({ ...record, ...change(record) });
	recordWritten(setup, record, Date.now() - asked);
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
	known: Partial<
		Pick<
			SweepDeps,
			| "awake"
			| "betweenIdleTakes"
			| "busyAmong"
			| "claims"
			| "idleTakes"
			| "idleWithinMs"
			| "memory"
		>
	> = {},
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

	it("takes as many as its runner says, oldest first, keeping the rest for the next", async () => {
		const setup = await setUp();
		const older = await leftAlone(setup, "older", IDLE + HOUR);
		const newer = await leftAlone(setup, "newer", IDLE);

		const outcome = await sweepWhileOpen(setup, { idleTakes: 1 });

		expect(outcome.taken.map((one) => one.path)).toEqual([older.tree]);
		expect(existsSync(newer.tree), "the newer waits for the next sweep").toBe(
			true,
		);
	});

	it("waits between its takes, never before the first", async () => {
		const setup = await setUp();
		const older = await leftAlone(setup, "older", IDLE + HOUR);
		const newer = await leftAlone(setup, "newer", IDLE);
		const atEachWait: boolean[][] = [];

		const outcome = await sweepWhileOpen(setup, {
			betweenIdleTakes: async () => {
				atEachWait.push([existsSync(older.tree), existsSync(newer.tree)]);
			},
		});

		expect(outcome.taken).toHaveLength(2);
		expect(atEachWait, "which stood at each wait").toEqual([[false, true]]);
	});

	it("takes a host's share though its time is spent before it starts, leaving none it could take", async () => {
		// A loaded machine gets fewer than its runner allows, never fewer than
		// a host would take.
		const setup = await setUp();
		const older = await leftAlone(setup, "older", IDLE + HOUR);
		const newer = await leftAlone(setup, "newer", IDLE);

		const outcome = await sweepWhileOpen(setup, {
			idleTakes: 200,
			idleWithinMs: 0,
		});

		expect(outcome.taken.map((one) => one.path)).toEqual([
			older.tree,
			newer.tree,
		]);
		expect(outcome.idleLeft, "none left that its share couldn't take").toBe(
			undefined,
		);
	});

	it("stops judging past a host's share once its awake time since it began runs out, saying how many it left", async () => {
		// Its clock, started far from zero, moves only as it pauses between
		// takes, so taking is what spends its time: it runs out once the
		// share and one more are taken, and the newest waits. A run that
		// chose every one before taking any would take them all.
		const setup = await setUp();
		const trees: string[] = [];
		for (let at = 0; at <= IDLE_TAKES_PER_SWEEP + 1; at += 1) {
			const { tree } = await leftAlone(setup, `left-${at}`, IDLE + at * HOUR);
			trees.push(tree);
		}
		let clock = 100;

		const outcome = await sweepWhileOpen(setup, {
			idleTakes: 200,
			idleWithinMs: IDLE_TAKES_PER_SWEEP,
			awake: () => clock,
			betweenIdleTakes: async () => {
				clock += 1;
			},
		});

		expect(outcome.taken).toHaveLength(IDLE_TAKES_PER_SWEEP + 1);
		expect(outcome.idleLeft, "the newest, left for the next run").toBe(1);
		expect(existsSync(trees[0] ?? ""), "the newest waits").toBe(true);
		// Twenty-one real worktrees took 128 s on a machine at load 170.
	}, 300_000);

	it("keeps one whose record's lock it can't get and takes the rest, each by its own record's name", async () => {
		// A lock held too long on one of hundreds must not end the run,
		// which would cost the outside stamp; and each take names its
		// record, so none lists the records folder.
		const setup = await setUp();
		const trees: string[] = [];
		for (let at = 0; at < 3; at += 1) {
			const { tree } = await leftAlone(setup, `left-${at}`, IDLE + at * HOUR);
			trees.push(tree);
		}
		const real = setup.memory;
		const keys: (string | undefined)[] = [];
		const held = "its record's lock has been held for over 10s";
		const memory: typeof real = Object.create(real);
		memory.whileUnusedSince = (path, since, take, key) => {
			keys.push(key);
			// Coded as file-lock's own throw is, which its test pins.
			if (keys.length === 2) {
				throw Object.assign(new Error(held), { code: "ELOCKHELD" });
			}
			return real.whileUnusedSince(path, since, take, key);
		};
		const named = real
			.recall()
			.filter((one) => trees.includes(one.path))
			.map((one) => one.identity.key);

		const outcome = await sweepWhileOpen(setup, { memory });

		const middle = trees[1] ?? "";
		expect(outcome.taken.map((one) => one.path).sort()).toEqual(
			[trees[0], trees[2]].sort(),
		);
		expect(outcome.kept, "the one it couldn't lock").toContainEqual({
			path: middle,
			why: held,
		});
		expect(outcome.idleUnjudged, "one lock ended the run").toBeUndefined();
		expect(existsSync(middle), "the one it couldn't lock went").toBe(true);
		expect(keys.sort(), "a take that didn't name its record").toEqual(
			named.sort(),
		);
	});

	it("ends the run unjudged when a take fails other than on a held lock, keeping the rest", async () => {
		// A records folder refusing writes fails every take alike, so filing
		// each as kept would end a run that judged nothing as one that ran,
		// stamped, and the hosts stood down on it.
		const setup = await setUp();
		const trees: string[] = [];
		for (let at = 0; at < 2; at += 1) {
			const { tree } = await leftAlone(setup, `left-${at}`, IDLE + at * HOUR);
			trees.push(tree);
		}
		const real = setup.memory;
		let asked = 0;
		const refused = "EACCES: permission denied, open 'cut/left.json.lock'";
		const memory: typeof real = Object.create(real);
		memory.whileUnusedSince = () => {
			asked += 1;
			throw Object.assign(new Error(refused), { code: "EACCES" });
		};

		const outcome = await sweepWhileOpen(setup, { memory });

		expect(outcome.idleUnjudged, "the run read as judged").toBe(refused);
		expect(outcome.taken, "a snapshot was taken").toEqual([]);
		expect(
			outcome.kept.filter((one) => one.why === refused),
			"a refused take was filed as kept",
		).toEqual([]);
		expect(asked, "it went on taking past the failure").toBe(1);
		for (const tree of trees) {
			expect(existsSync(tree), `${tree} went`).toBe(true);
		}
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
			// Free at the first reading, so its git is read; busy at its own
			// reading, just before its take.
			busyAmong: async (paths) => {
				asked.push([...paths].sort());
				return new Set(
					asked.length > 1 ? paths.filter((path) => path === worked) : [],
				);
			},
		});

		expect(
			[asked[0], asked.slice(1).sort()],
			"what processes hold wasn't read of every aged tree, then of each just before its take",
		).toEqual([[free, worked].sort(), [[free], [worked]]]);
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
			asked.slice(1),
			"a tree busy at the first reading was among those chosen",
		).toEqual([[free]]);
		expect(outcome.taken.map((one) => one.path)).toEqual([free]);
		expect(existsSync(worked), "a tree a process works in went").toBe(true);
	});

	it("keeps one whose folder moved after the choosing, judged again under its record's lock", async () => {
		const setup = await setUp();
		const { tree } = await leftAlone(setup, "touched", IDLE);
		let readings = 0;

		const outcome = await sweepWhileOpen(setup, {
			// Something works there as its own reading runs, under the lock.
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
		expect(
			outcome.idleUnjudged,
			"the sweep didn't say why it judged no open session's snapshot",
		).toContain("can't say which processes hold");
	});

	it("takes none whose own reading, just before its take, can't say what processes hold", async () => {
		const setup = await setUp();
		const { tree } = await leftAlone(setup, "unread", IDLE);
		let readings = 0;

		const outcome = await sweepWhileOpen(setup, {
			busyAmong: async () => {
				readings += 1;
				return readings === 1 ? new Set() : undefined;
			},
		});

		expect(outcome.taken, "a snapshot was taken on a blind reading").toEqual(
			[],
		);
		expect(existsSync(tree), "a tree went on a blind reading").toBe(true);
	});

	it("keeps one a session asked for again while the sweep chose", async () => {
		const setup = await setUp();
		const { tree } = await leftAlone(setup, "asked-again", IDLE);
		let readings = 0;

		const outcome = await sweepWhileOpen(setup, {
			// The ask lands between the choosing and the take's lock.
			busyAmong: async () => {
				readings += 1;
				const record = find(setup, tree);
				if (readings === 1 && record !== undefined) {
					await setup.memory.rememberHeldByUs(record, machine);
				}
				return new Set();
			},
		});

		expect(
			outcome.taken,
			"a snapshot asked for while the sweep chose was taken",
		).toEqual([]);
		expect(existsSync(tree), "a snapshot asked for again went").toBe(true);
	});

	it("keeps one git would refuse to remove, as a locked one, from the takes", async () => {
		const setup = await setUp();
		const { tree } = await leftAlone(setup, "locked", IDLE);
		await git(setup.main, "worktree", "lock", tree);
		await untouchedFor(tree, IDLE);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken, "a locked snapshot was taken").toEqual([]);
		expect(
			outcome.refused,
			"a locked snapshot filled a take, refused only by git",
		).toEqual([]);
	});

	it("takes another provider's spent tree and drops roots though judging open sessions' snapshots fails", async () => {
		const setup = await setUp();
		await leftAlone(setup, "idle", IDLE);
		const spent = setup.elsewhereTree("spent");
		settleFolder(spent);

		const outcome = await sweepEndedTrees({
			exec,
			memory: setup.memory,
			claims: [],
			lockPath: setup.lockPath,
			// The take holds the tree as this process meanwhile.
			facts: machineWithUs,
			liveSessions: async () => new Set([OPEN_SESSION]),
			providers: () => [elsewhere(undefined)],
			busyAmong: async () => {
				throw new Error("no reading today");
			},
		});

		expect(
			outcome.taken.map((one) => one.path),
			"another provider's spent tree stayed when the idle phase failed",
		).toEqual([spent]);
		expect(outcome.idleUnjudged, "the failure went unsaid").toBe(
			"no reading today",
		);
	});

	it("keeps one a session on older code asked for, its date stale but its record rewritten", async () => {
		// Older code writes back the record it read, its date stale or
		// gone, adding itself as an owner, as a reload back onto it does.
		const setup = await setUp();
		const joined = (await leftAlone(setup, "joined", IDLE)).tree;
		const before = find(setup, joined);
		if (before === undefined) throw new Error(`${joined} has no record`);
		setup.memory.remember(before);
		const undated = (await leftAlone(setup, "undated", IDLE)).tree;
		const record = find(setup, undated);
		if (record === undefined) throw new Error(`${undated} has no record`);
		const { usedAt: _, ...withoutDating } = record;
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
