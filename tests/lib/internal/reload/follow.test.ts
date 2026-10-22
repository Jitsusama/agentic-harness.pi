/**
 * Following the install: when to reload, whether its dependencies have
 * caught up, what came in, and seeing HEAD move.
 */

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cameIn,
	dependenciesReady,
	headOf,
	type Moved,
	untilCheap,
	watchHeads,
	whenToReload,
} from "../../../../lib/internal/reload/follow.ts";
import { disposeRepo, freshRepo, git } from "../../../support/git-fixture.ts";
import { quietFor, until } from "../../../support/until.ts";

const repos: string[] = [];
const stops: (() => void)[] = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	for (const repo of repos.splice(0)) disposeRepo(repo);
});

async function repo(): Promise<string> {
	const dir = await freshRepo("follow");
	repos.push(dir);
	return dir;
}

async function commit(dir: string, message: string): Promise<void> {
	writeFileSync(join(dir, `${message.length}-${Date.now()}.txt`), message);
	await git(dir, "add", "-A");
	await git(dir, "commit", "-qm", message);
}

describe("whenToReload", () => {
	const still = {
		swapped: false,
		idle: true,
		pendingJobs: 0,
		ready: true,
		cheap: true,
	};

	it("reloads an idle session at once, and a busy one after its run", () => {
		expect(whenToReload(still)).toBe("now");
		expect(whenToReload({ ...still, idle: false })).toBe("after-run");
	});

	it("waits while a reload would lose a job or load a half-installed tree", () => {
		expect(whenToReload({ ...still, pendingJobs: 1 })).toBe("wait");
		expect(whenToReload({ ...still, ready: false })).toBe("wait");
	});

	it("never moves a session running a tree on purpose", () => {
		expect(whenToReload({ ...still, swapped: true })).toBe("never");
	});

	it("waits while losing the cache would cost a rewrite", () => {
		expect(whenToReload({ ...still, cheap: false })).toBe("wait");
		expect(whenToReload({ ...still, idle: false, cheap: false })).toBe("wait");
	});
});

describe("untilCheap", () => {
	const clock = {
		movedAt: 1_000,
		lastTurnAt: 1_000,
		now: 1_000,
		lifetimeMs: 100,
		ceilingMs: 500,
	};

	it("waits for the cache to expire after the last turn", () => {
		expect(untilCheap(clock)).toBe(100);
		expect(untilCheap({ ...clock, now: 1_100 })).toBe(0);
	});

	it("waits no longer than the ceiling after the move", () => {
		expect(untilCheap({ ...clock, lastTurnAt: 1_450, now: 1_450 })).toBe(50);
		expect(untilCheap({ ...clock, lastTurnAt: 1_500, now: 1_500 })).toBe(0);
	});
});

describe("dependenciesReady", () => {
	it("waits for pnpm to follow a lockfile that changed", async () => {
		const dir = await repo();
		writeFileSync(join(dir, "pnpm-lock.yaml"), "lock\n");
		mkdirSync(join(dir, "node_modules"));
		writeFileSync(join(dir, "node_modules", ".modules.yaml"), "x\n");
		const lock = join(dir, "pnpm-lock.yaml");
		const installed = join(dir, "node_modules", ".modules.yaml");
		utimesSync(installed, 1_000, 1_000);
		utimesSync(lock, 2_000, 2_000);
		expect(dependenciesReady(dir)).toBe(false);
		utimesSync(installed, 3_000, 3_000);
		expect(dependenciesReady(dir)).toBe(true);
	});

	it("has nothing to wait for without a lockfile", async () => {
		expect(dependenciesReady(await repo())).toBe(true);
	});
});

describe("cameIn", () => {
	it("names a merged pull request by its number and title", async () => {
		const dir = await repo();
		const from = (await headOf(dir)) ?? "";
		await git(dir, "checkout", "-qb", "topic");
		await commit(dir, "feat: the work");
		await git(dir, "checkout", "-q", "main");
		await git(
			dir,
			"merge",
			"-q",
			"--no-ff",
			"topic",
			"-m",
			"Merge pull request #582 from someone/topic",
			"-m",
			"Deliver Mail Only Where It Bears",
		);
		await commit(dir, "fix: straight onto main");
		const to = (await headOf(dir)) ?? "";

		expect(await cameIn(dir, from, to)).toEqual([
			"fix: straight onto main",
			"#582 Deliver Mail Only Where It Bears",
		]);
	});
});

describe("watchHeads", () => {
	it("says once when HEAD moves, after the burst of writes settles", async () => {
		const dir = await repo();
		const from = await headOf(dir);
		const seen: Moved[] = [];
		stops.push(await watchHeads([dir], (moved) => seen.push(moved), 50));

		await commit(dir, "one");
		await commit(dir, "two");
		await until("the move is said", () => seen.length > 0);
		await quietFor(50, 4);

		expect(seen).toEqual([{ root: dir, from, to: await headOf(dir) }]);
	});

	it("sees a ref moved without a checkout", async () => {
		const dir = await repo();
		await git(dir, "checkout", "-qb", "side");
		await commit(dir, "ahead");
		const ahead = await headOf(dir);
		await git(dir, "checkout", "-q", "main");
		const seen: Moved[] = [];
		stops.push(await watchHeads([dir], (moved) => seen.push(moved), 50));
		// Let the checkout's own writes go by, so only the ref's move counts.
		await quietFor(50, 4);

		await git(dir, "update-ref", "refs/heads/main", ahead ?? "");

		await until("the move is said", () => seen.length > 0);
		expect(seen[0]?.to).toBe(ahead);
	});

	it("says nothing when the git directory is touched but HEAD stays", async () => {
		const dir = await repo();
		const seen: Moved[] = [];
		stops.push(await watchHeads([dir], (moved) => seen.push(moved), 50));

		await git(dir, "branch", "side");
		await quietFor(50, 6);

		expect(seen).toEqual([]);
	});
});
