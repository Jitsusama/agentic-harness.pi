/**
 * Choosing which snapshots a live session pinned and left to judge, and
 * when to stop, against git's answers made up rather than a real
 * repository, so each case runs in milliseconds.
 */

import { describe, expect, it } from "vitest";
import type { HeldTree } from "../../../../lib/core/work/broker.ts";
import {
	eachIdleSnapshot,
	IDLE_HELD_MS,
	IDLE_TAKES_PER_SWEEP,
	type IdleChoice,
	idleSnapshots,
} from "../../../../lib/core/work/sweep-idle.ts";
import { RUNNING } from "../support/sweep-live.ts";

/** Past the idle window by a minute. */
const IDLE = IDLE_HELD_MS + 60_000;

/** An hour, in milliseconds. */
const HOUR = 60 * 60 * 1000;

/**
 * `count` snapshots at paths nothing stands at, each idle an hour longer
 * than the next and clean by what git is made to answer, with a choice
 * that records where git was asked, so choosing is seen without a disk.
 */
function idleFakes(count: number) {
	const commit = "a".repeat(40);
	const now = Date.now();
	const trees: HeldTree[] = Array.from({ length: count }, (_, at) => ({
		identity: { key: `snapshot-fake-${at}-${commit}`, shareable: true },
		path: `/nowhere/fake-${at}`,
		providerId: "git-worktree",
		owners: [RUNNING],
		usedAt: now - IDLE - at * HOUR,
	}));
	const answers: Record<string, string> = {
		"rev-parse HEAD": commit,
		"reflog --format=%H HEAD": commit,
		"rev-parse --absolute-git-dir": "/nowhere/.git",
		"status --porcelain=v1 --untracked-files=all": "",
	};
	const judgedIn = new Set<string>();
	const asked = new Map(trees.map((tree) => [tree.path, tree.usedAt]));
	const choice: IdleChoice = {
		exec: async (_command, args) => {
			const where = args[1];
			if (where !== undefined) judgedIn.add(where);
			return {
				code: 0,
				stdout: answers[args.slice(3).join(" ")] ?? "unasked",
				stderr: "",
			};
		},
		claims: [],
		now,
		askedAt: (path) => asked.get(path),
		busyAmong: async () => new Set(),
	};
	const oldestFirst = trees.map((tree) => tree.path).reverse();
	return { trees, choice, judgedIn, oldestFirst };
}

describe("choosing the snapshots to take", () => {
	it("chooses at most a sweep's takes, oldest first, none of them busy, though the busy are older", async () => {
		const commit = "a".repeat(40);
		const now = Date.now();
		// Paths nothing stands at, so only the asks date them: the busy
		// ones oldest, so a cap read before busy would hold only them.
		const snapshot = (name: string, ago: number): HeldTree => ({
			identity: { key: `snapshot-${name}-${commit}`, shareable: true },
			path: `/nowhere/${name}`,
			providerId: "git-worktree",
			owners: [RUNNING],
			usedAt: now - ago,
		});
		const count = IDLE_TAKES_PER_SWEEP + 1;
		const busy = Array.from({ length: count }, (_, at) =>
			snapshot(`busy-${at}`, IDLE + (count + at) * HOUR),
		);
		const free = Array.from({ length: count }, (_, at) =>
			snapshot(`free-${at}`, IDLE + at * HOUR),
		);
		const asked = new Map(
			[...busy, ...free].map((tree) => [tree.path, tree.usedAt]),
		);
		const answers: Record<string, string> = {
			"rev-parse HEAD": commit,
			"reflog --format=%H HEAD": commit,
			"rev-parse --absolute-git-dir": "/nowhere/.git",
			"status --porcelain=v1 --untracked-files=all": "",
		};

		const chosen = await idleSnapshots([...busy, ...free], {
			exec: async (_command, args) => ({
				code: 0,
				stdout: answers[args.slice(3).join(" ")] ?? "unasked",
				stderr: "",
			}),
			claims: [],
			now,
			askedAt: (path) => asked.get(path),
			busyAmong: async () => new Set(busy.map((tree) => tree.path)),
		});

		expect(
			chosen.map((one) => one.tree.path),
			"not the oldest free snapshots, up to a sweep's takes",
		).toEqual(
			free
				.slice(count - IDLE_TAKES_PER_SWEEP)
				.reverse()
				.map((tree) => tree.path),
		);
	});

	it("chooses past a host's share when its runner says, oldest first, saying how many its count left", async () => {
		const many = idleFakes(IDLE_TAKES_PER_SWEEP + 2);
		const left: number[] = [];

		const chosen = await idleSnapshots(many.trees, {
			...many.choice,
			most: IDLE_TAKES_PER_SWEEP + 1,
			left: (count) => left.push(count),
		});

		expect(chosen.map((one) => one.tree.path)).toEqual(
			many.oldestFirst.slice(0, IDLE_TAKES_PER_SWEEP + 1),
		);
		expect(left, "the one its count left").toEqual([1]);
	});

	it("says nothing is left when its count stops it with only busy ones after", async () => {
		const many = idleFakes(4);
		const left: number[] = [];

		await idleSnapshots(many.trees, {
			...many.choice,
			most: 3,
			busyAmong: async () => new Set(many.oldestFirst.slice(-1)),
			left: (count) => left.push(count),
		});

		expect(left).toEqual([]);
	});

	it("stops judging when its time runs out partway past a host's share, leaving those seen busy out of what it left", async () => {
		const many = idleFakes(IDLE_TAKES_PER_SWEEP + 10);
		const busy = new Set(many.oldestFirst.slice(-2));
		const left: number[] = [];
		let asked = 0;

		const chosen = await idleSnapshots(many.trees, {
			...many.choice,
			most: 200,
			busyAmong: async () => busy,
			// Asked first once the share is given: spent at the fourth asking.
			spent: () => asked++ >= 3,
			left: (count) => left.push(count),
		});

		const judged = many.oldestFirst.slice(0, IDLE_TAKES_PER_SWEEP + 3);
		expect(chosen.map((one) => one.tree.path)).toEqual(judged);
		expect([...many.judgedIn], "git asked only in those chosen").toEqual(
			judged,
		);
		expect(left, "the seven after them, less the two seen busy").toEqual([5]);
	});

	it("judges no more past a host's share once its time is spent, saying how many it left", async () => {
		const many = idleFakes(IDLE_TAKES_PER_SWEEP + 2);
		const left: number[] = [];

		const chosen = await idleSnapshots(many.trees, {
			...many.choice,
			most: 200,
			spent: () => true,
			left: (count) => left.push(count),
		});

		const share = many.oldestFirst.slice(0, IDLE_TAKES_PER_SWEEP);
		expect(chosen.map((one) => one.tree.path)).toEqual(share);
		expect([...many.judgedIn], "git asked only in its share").toEqual(share);
		expect(left).toEqual([2]);
	});

	it("judges each only once the one before has been dealt with", async () => {
		const many = idleFakes(3);
		const judgedAtEach: number[] = [];

		for await (const _idle of eachIdleSnapshot(many.trees, many.choice)) {
			judgedAtEach.push(many.judgedIn.size);
		}

		expect(judgedAtEach).toEqual([1, 2, 3]);
	});

	it("keeps one whose record can't date its last ask, however old its own date", async () => {
		// A record filed under another name, or unreadable, says nothing
		// of when it was last asked for, so it reads as used now.
		const commit = "a".repeat(40);
		const now = Date.now();
		const snapshot = (name: string): HeldTree => ({
			identity: { key: `snapshot-${name}-${commit}`, shareable: true },
			path: `/nowhere/${name}`,
			providerId: "git-worktree",
			owners: [RUNNING],
			usedAt: now - IDLE - 10 * HOUR,
		});
		const dated = snapshot("dated");
		const undated = snapshot("undated");
		const answers: Record<string, string> = {
			"rev-parse HEAD": commit,
			"reflog --format=%H HEAD": commit,
			"rev-parse --absolute-git-dir": "/nowhere/.git",
			"status --porcelain=v1 --untracked-files=all": "",
		};

		const chosen = await idleSnapshots([undated, dated], {
			exec: async (_command, args) => ({
				code: 0,
				stdout: answers[args.slice(3).join(" ")] ?? "unasked",
				stderr: "",
			}),
			claims: [],
			now,
			askedAt: (path) => (path === dated.path ? dated.usedAt : undefined),
			busyAmong: async () => new Set(),
		});

		expect(
			chosen.map((one) => one.tree.path),
			"an undated snapshot was chosen, or the dated one beside it wasn't",
		).toEqual([dated.path]);
	});
});
