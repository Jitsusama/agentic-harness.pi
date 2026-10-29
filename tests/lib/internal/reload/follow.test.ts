/**
 * Following the install: when to reload, whether its dependencies have
 * caught up, what came in, and seeing HEAD move.
 */

import {
	mkdirSync,
	renameSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cameIn,
	dependenciesReady,
	headOf,
	INSTALL_GRACE_MS,
	type Moved,
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
	const still = { swapped: false, idle: true, ready: true };

	it("reloads an idle session at once, and a busy one after its run", () => {
		expect(whenToReload(still)).toBe("now");
		expect(whenToReload({ ...still, idle: false })).toBe("after-run");
	});

	it("waits while a reload would load a half-installed tree", () => {
		expect(whenToReload({ ...still, ready: false })).toBe("wait");
	});

	it("never moves a session running a tree on purpose", () => {
		expect(whenToReload({ ...still, swapped: true })).toBe("never");
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

	it("waits for an install that follows the move, though the lockfile stayed", async () => {
		// pi installs after every update, and pnpm takes the packages away
		// while it does: on 26 October sessions reloading then lost 15.
		const dir = await repo();
		writeFileSync(join(dir, "pnpm-lock.yaml"), "lock\n");
		mkdirSync(join(dir, "node_modules"));
		const installed = join(dir, "node_modules", ".modules.yaml");
		writeFileSync(installed, "x\n");
		utimesSync(join(dir, "pnpm-lock.yaml"), 1_000, 1_000);
		utimesSync(installed, 2_000, 2_000);
		const movedAt = 5_000_000;
		expect(dependenciesReady(dir, movedAt, movedAt + 1_000)).toBe(false);
		utimesSync(installed, 5_020, 5_020);
		expect(dependenciesReady(dir, movedAt, movedAt + 21_000)).toBe(true);
	});

	it("takes a move nothing installed after as done once the grace has passed", async () => {
		const dir = await repo();
		writeFileSync(join(dir, "pnpm-lock.yaml"), "lock\n");
		mkdirSync(join(dir, "node_modules"));
		const installed = join(dir, "node_modules", ".modules.yaml");
		writeFileSync(installed, "x\n");
		utimesSync(join(dir, "pnpm-lock.yaml"), 1_000, 1_000);
		utimesSync(installed, 2_000, 2_000);
		const movedAt = 5_000_000;
		expect(
			dependenciesReady(dir, movedAt, movedAt + INSTALL_GRACE_MS - 1),
		).toBe(false);
		expect(dependenciesReady(dir, movedAt, movedAt + INSTALL_GRACE_MS)).toBe(
			true,
		);
	});

	it("takes a version a link moved onto as ready once its own install is, whenever that was", async () => {
		// pi-packages installs each version in its own folder, then moves the
		// link: on 29 October every session waited the whole grace for an
		// install that had already finished.
		const dir = await repo();
		const version = join(dir, "versions", "two");
		mkdirSync(join(version, "node_modules"), { recursive: true });
		writeFileSync(join(version, "pnpm-lock.yaml"), "lock\n");
		const installed = join(version, "node_modules", ".modules.yaml");
		writeFileSync(installed, "x\n");
		utimesSync(join(version, "pnpm-lock.yaml"), 1_000, 1_000);
		utimesSync(installed, 2_000, 2_000);
		const current = join(dir, "current");
		symlinkSync(version, current);
		const movedAt = 5_000_000;

		expect(dependenciesReady(current, movedAt, movedAt + 1_000)).toBe(true);
		// Behind its own lockfile, it waits as any install does.
		utimesSync(installed, 500, 500);
		expect(dependenciesReady(current, movedAt, movedAt + 1_000)).toBe(false);
	});

	it("waits while no install has finished", async () => {
		const dir = await repo();
		writeFileSync(join(dir, "pnpm-lock.yaml"), "lock\n");
		mkdirSync(join(dir, "node_modules"));
		expect(dependenciesReady(dir)).toBe(false);
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
		// The burst here is two commits, with an add and a commit run
		// between their HEAD writes. On a loaded CI runner those took longer
		// than a 50 ms settle, so the two commits were rightly said as two
		// bursts. The settle is sized for the gap, not for speed.
		const burstMs = 1_500;
		const dir = await repo();
		const from = await headOf(dir);
		const seen: Moved[] = [];
		stops.push(await watchHeads([dir], (moved) => seen.push(moved), burstMs));

		const before = Date.now();
		await commit(dir, "one");
		await commit(dir, "two");
		await until("the move is said", () => seen.length > 0, 20_000);
		const after = Date.now();
		await quietFor(burstMs, 2);

		expect(seen).toEqual([
			{ root: dir, from, to: await headOf(dir), at: expect.any(Number) },
		]);
		// When it moved is when the burst ended, not when it was said.
		const at = seen[0]?.at ?? 0;
		expect(at).toBeGreaterThanOrEqual(before - burstMs);
		expect(at).toBeLessThanOrEqual(after - burstMs);
	}, 30_000);

	// pi reuses the loaded code when a rollover replaces the session, so
	// the runtime after it runs code from before a move it never saw.
	it("says a move made before a later watch, under the same loaded code", async () => {
		const dir = await repo();
		const from = await headOf(dir);
		(await watchHeads([dir], () => {}, 50))();
		await commit(dir, "while replaced");
		const seen: Moved[] = [];

		stops.push(await watchHeads([dir], (moved) => seen.push(moved), 50));

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

	it("follows an install whose link is renamed onto another release", async () => {
		// As pi-packages swaps one in: a release per commit, and `current`
		// replaced by a new link renamed over it.
		const old = await repo();
		const next = await repo();
		await commit(next, "the next release");
		const install = await repo();
		const current = join(install, "current");
		symlinkSync(old, current);
		const seen: Moved[] = [];
		stops.push(await watchHeads([current], (moved) => seen.push(moved), 50));

		symlinkSync(next, join(install, ".current.new"));
		renameSync(join(install, ".current.new"), current);

		await until("the move is said", () => seen.length > 0);
		expect(seen[0]).toMatchObject({
			root: current,
			from: await headOf(old),
			to: await headOf(next),
		});
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
