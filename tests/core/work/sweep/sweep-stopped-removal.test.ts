/**
 * Finishing removals that stopped part way where the broker cuts its
 * trees: a release whose `git worktree remove` was stopped leaves a
 * folder with no `.git` and no record, and a take stopped after its move
 * leaves one named `.going-`. Neither is a tree any longer, so nothing
 * else judges them; on 24 November 54 such folders held 3.1 GiB.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	SweepClaims,
	SweepDeps,
} from "../../../../lib/core/work/sweep.ts";
import { sweepEndedTrees } from "../../../../lib/core/work/sweep.ts";
import {
	STOPPED_REMOVAL_MS,
	STOPPED_REMOVALS_PER_SWEEP,
} from "../../../../lib/core/work/sweep-orphan.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	disposeAll,
	ENDED,
	exec,
	machine,
	setUp,
} from "../support/sweep-live.ts";

afterEach(disposeAll);

const HOUR = 60 * 60 * 1000;

/** Sets `paths` to `ms` ago. */
function age(ms: number, ...paths: string[]): void {
	const then = (Date.now() - ms) / 1000;
	for (const one of paths) utimesSync(one, then, then);
}

/** A folder named `name` in `dir` holding a file, left alone for `ms`. */
function leftover(dir: string, name: string, ms: number): string {
	const path = join(dir, name);
	const modules = join(path, "modules");
	const file = join(modules, "left.lua");
	mkdirSync(modules, { recursive: true });
	writeFileSync(file, "-- left\n");
	age(ms, file, modules, path);
	return path;
}

/** A busy reading that answers only for what it is asked, and notes it. */
function reading(busy: readonly string[]) {
	const asked: string[][] = [];
	const busyAmong: SweepDeps["busyAmong"] = async (paths) => {
		asked.push([...paths]);
		return new Set(paths.filter((path) => busy.includes(path)));
	};
	return { asked, busyAmong };
}

describe("removals stopped part way", () => {
	it("finishes one no record names and nothing has touched for a day, and a take's moved-aside folder", async () => {
		const { memory, state } = await setUp();
		const old = STOPPED_REMOVAL_MS + HOUR;
		const stopped = leftover(state, "snapshot-github-o-r-abc123", old);
		const going = leftover(state, "worktree-github-o-r.going-1a2b3c4d", old);
		const fresh = leftover(
			state,
			"snapshot-github-o-r-def456",
			STOPPED_REMOVAL_MS - HOUR,
		);
		const recorded = leftover(state, "snapshot-github-o-r-0a0b0c", old);
		memory.remember({
			identity: { key: "snapshot-github-o-r-0a0b0c", shareable: false },
			path: recorded,
			providerId: "git-worktree",
			owners: [ENDED],
		});
		const worked = leftover(state, "snapshot-github-o-r-111111", old);
		const strange = leftover(state, "raw", old);
		const { asked, busyAmong } = reading([worked]);

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath: join(state, "sweep.lock"),
			facts: machine,
			treesDir: state,
			busyAmong,
		});

		const taken = outcome.taken.map((tree) => tree.path).sort();
		const finished = [stopped, going].sort();
		expect(taken, "what the sweep finished removing").toEqual(finished);
		expect(
			asked.every((paths) => paths.length === 1),
			"whether each was asked about on its own",
		).toBe(true);
		expect(asked.flat().sort(), "what the busy reading was asked").toEqual(
			[stopped, worked, going].sort(),
		);
		expect(existsSync(stopped), "a stopped removal stayed").toBe(false);
		expect(existsSync(going), "a take's moved-aside folder stayed").toBe(false);
		expect(existsSync(fresh), "one touched within the day went").toBe(true);
		expect(existsSync(recorded), "one a record names went").toBe(true);
		expect(existsSync(worked), "one something works in went").toBe(true);
		expect(existsSync(strange), "one not named as a tree went").toBe(true);
		expect(
			outcome.kept.find((one) => one.path === worked)?.why,
			"why the worked-in folder stayed",
		).toMatch(/something works in it/);
		expect(
			readdirSync(state).filter((name) => name.includes(".going-")),
			"what a finished removal left",
		).toEqual([]);
	});

	it("keeps every one when the machine can't say what works in them", async () => {
		const { memory, state } = await setUp();
		const stopped = leftover(
			state,
			"snapshot-github-o-r-abc123",
			STOPPED_REMOVAL_MS + HOUR,
		);
		const other = leftover(
			state,
			"snapshot-github-o-r-def456",
			STOPPED_REMOVAL_MS + HOUR,
		);
		let readings = 0;

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath: join(state, "sweep.lock"),
			facts: machine,
			treesDir: state,
			busyAmong: async () => {
				readings += 1;
				return undefined;
			},
		});

		expect(outcome.taken, "taken on a blind reading").toEqual([]);
		expect(existsSync(stopped), "one went on a blind reading").toBe(true);
		expect(existsSync(other), "another went on a blind reading").toBe(true);
		expect(readings, "readings after the first blind one").toBe(1);
		expect(
			outcome.kept.find((one) => one.path === stopped)?.why,
			"why it stayed",
		).toMatch(/can't say/);
	});

	it("keeps a dirty tree a take left aside, and a tree whose branch is named going, since git still reads both", async () => {
		const { main, memory, state } = await setUp();
		const old = STOPPED_REMOVAL_MS + HOUR;
		const aside = join(state, "worktree-github-o-r-dirty.going-1a2b3c4d");
		await git(main, "worktree", "add", "-q", "--detach", aside, "main");
		writeFileSync(join(aside, "notes.txt"), "unsaved\n");
		const named = join(state, "worktree-github-o-r-fix-v2.going-away");
		await git(main, "worktree", "add", "-q", "-b", "fix/v2.going-away", named);
		for (const tree of [aside, named]) {
			age(old, ...readdirSync(tree).map((name) => join(tree, name)), tree);
		}

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath: join(state, "sweep.lock"),
			facts: machine,
			treesDir: state,
			busyAmong: reading([]).busyAmong,
		});

		expect(outcome.taken, "a tree git reads was finished").toEqual([]);
		expect(existsSync(join(aside, "notes.txt")), "the unsaved work went").toBe(
			true,
		);
		expect(existsSync(named), "the tree named going went").toBe(true);
	});

	it("keeps one a claim names, or reaches into, and one with something fresh two levels down", async () => {
		const { memory, state } = await setUp();
		const old = STOPPED_REMOVAL_MS + HOUR;
		const held = leftover(state, "snapshot-github-o-r-c1c1c1", old);
		const reached = leftover(state, "snapshot-github-o-r-d2d2d2", old);
		const deep = leftover(state, "snapshot-github-o-r-e3e3e3", old);
		const file = join(deep, "modules", "left.lua");
		writeFileSync(file, "-- written now\n");
		age(old, join(deep, "modules"), deep);
		const claims: SweepClaims = {
			held: [held],
			untilSpent: [join(reached, "modules")],
		};

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims,
			lockPath: join(state, "sweep.lock"),
			facts: machine,
			treesDir: state,
			busyAmong: reading([]).busyAmong,
		});

		expect(outcome.taken, "a claimed or fresh folder was finished").toEqual([]);
		for (const path of [held, reached, deep]) {
			expect(existsSync(path), `${path} went`).toBe(true);
		}
	});

	it("finishes a few each sweep, pausing between them, and keeps one a cut began in meanwhile", async () => {
		const { memory, state } = await setUp();
		const old = STOPPED_REMOVAL_MS + HOUR;
		const names = Array.from(
			{ length: STOPPED_REMOVALS_PER_SWEEP + 2 },
			(_, at) => `snapshot-github-o-r-${String(at).padStart(6, "0")}`,
		);
		const leftovers = names.map((name) => leftover(state, name, old));
		const [cutInto] = leftovers;
		let pauses = 0;

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath: join(state, "sweep.lock"),
			facts: machine,
			treesDir: state,
			busyAmong: async () => {
				// A cut begins in the first while the reading runs.
				writeFileSync(join(cutInto ?? "", ".git"), "gitdir: elsewhere\n");
				return new Set();
			},
			betweenIdleTakes: async () => {
				pauses += 1;
			},
		});

		expect(outcome.taken, "how many one sweep finished").toHaveLength(
			STOPPED_REMOVALS_PER_SWEEP,
		);
		expect(pauses, "the pauses between them").toBe(
			STOPPED_REMOVALS_PER_SWEEP - 1,
		);
		expect(existsSync(cutInto ?? ""), "the one cut into went").toBe(true);
		expect(
			outcome.kept.find((one) => one.path === cutInto)?.why,
			"why the one cut into stayed",
		).toMatch(/changed as the sweep came to it/);
		expect(
			leftovers.filter((path) => existsSync(path)),
			"what waits for the next sweep",
		).toHaveLength(2);
	});

	it("keeps one whose checkout sits in a folder below its top, as World's does", async () => {
		const { memory, state } = await setUp();
		const old = STOPPED_REMOVAL_MS + HOUR;
		const tree = leftover(state, "worktree-github-o-r-world01", old);
		const src = join(tree, "src");
		mkdirSync(src);
		writeFileSync(join(src, ".git"), "gitdir: elsewhere\n");
		age(old, join(src, ".git"), src, tree);

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath: join(state, "sweep.lock"),
			facts: machine,
			treesDir: state,
			busyAmong: reading([]).busyAmong,
		});

		expect(outcome.taken, "a tree with a checkout below was finished").toEqual(
			[],
		);
		expect(existsSync(join(src, ".git")), "its checkout went").toBe(true);
	});

	it("asks what works in each just before moving it, since the removals before it take minutes", async () => {
		const { memory, state } = await setUp();
		const old = STOPPED_REMOVAL_MS + HOUR;
		const first = leftover(state, "snapshot-github-o-r-aaaaaa", old);
		const last = leftover(state, "snapshot-github-o-r-bbbbbb", old);
		let started = false;

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath: join(state, "sweep.lock"),
			facts: machine,
			treesDir: state,
			busyAmong: async (paths) =>
				new Set(started ? paths.filter((p) => p === last) : []),
			betweenIdleTakes: async () => {
				// A shell starts in the last once the first is gone, in the pause.
				started = !existsSync(first);
			},
		});

		expect(existsSync(first), "the idle one stayed").toBe(false);
		expect(existsSync(last), "the one a shell began in went").toBe(true);
		expect(
			outcome.kept.find((one) => one.path === last)?.why,
			"why the last stayed",
		).toMatch(/something works in it/);
	});

	it("lets no busy ones fill a sweep's count, so the rest are reached", async () => {
		const { memory, state } = await setUp();
		const old = STOPPED_REMOVAL_MS + HOUR;
		const busy = Array.from({ length: STOPPED_REMOVALS_PER_SWEEP }, (_, at) =>
			leftover(
				state,
				`snapshot-github-o-r-a${String(at).padStart(5, "0")}`,
				old,
			),
		);
		const idle = leftover(state, "snapshot-github-o-r-zzzzzz", old);

		await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath: join(state, "sweep.lock"),
			facts: machine,
			treesDir: state,
			busyAmong: reading(busy).busyAmong,
		});

		expect(existsSync(idle), "the idle one behind the busy ones stayed").toBe(
			false,
		);
		expect(
			busy.filter((path) => existsSync(path)),
			"the busy ones kept",
		).toHaveLength(STOPPED_REMOVALS_PER_SWEEP);
	});

	it("comes to fresh leftovers before ones set aside earlier, which a removal may have failed on", async () => {
		const { memory, state } = await setUp();
		const old = STOPPED_REMOVAL_MS + HOUR;
		for (let at = 0; at < STOPPED_REMOVALS_PER_SWEEP; at += 1) {
			leftover(state, `snapshot-github-o-r-a0000${at}.going-1a2b3c4d`, old);
		}
		const fresh = leftover(state, "snapshot-github-o-r-zzzzzz", old);

		await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath: join(state, "sweep.lock"),
			facts: machine,
			treesDir: state,
			busyAmong: reading([]).busyAmong,
		});

		expect(existsSync(fresh), "the fresh leftover waited behind asides").toBe(
			false,
		);
	});
});
