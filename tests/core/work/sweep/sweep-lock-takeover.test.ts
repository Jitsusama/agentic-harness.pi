/**
 * A sweep lock taken over from a sweep that still runs: that sweep may
 * wake mid-removal, so what it marked must go on standing, while a sweep
 * that ended and let its lock go leaves its marks to read as stopped.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type HeldSweepLock,
	lockRuns,
	sweepLock,
} from "../../../../lib/core/work/sweep-lock.ts";
import { NO_SUCH_PID } from "../support/sweep-live.ts";

/** Beats too far apart to touch the lock while a case runs. */
const UNTOUCHED = { everyMs: 60_000, forMs: 60_000 };

const dirs: string[] = [];
const held: HeldSweepLock[] = [];

afterEach(() => {
	for (const release of held.splice(0)) release();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** Where a sweep's lock goes, in a folder of its own. */
function lockPathFresh(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sweep-takeover-")));
	dirs.push(dir);
	return join(dir, "sweep.lock");
}

/** Hold the lock at `lockPath`, failing the case when another has it. */
function hold(lockPath: string): HeldSweepLock {
	const lock = sweepLock(lockPath, UNTOUCHED);
	if (typeof lock === "string") throw new Error(lock);
	held.push(lock);
	return lock;
}

/** Date the lock as one nobody has touched for two hours. */
function stale(lockPath: string): void {
	const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
	utimesSync(lockPath, old, old);
}

describe("a sweep lock taken over", () => {
	it("stands for what its sweep marked while that sweep still runs", () => {
		const lockPath = lockPathFresh();
		const first = hold(lockPath);
		stale(lockPath);
		const second = hold(lockPath);

		expect(first.ours(), "the first still reads the lock as its own").toBe(
			false,
		);
		expect(second.ours(), "the second reads the lock as another's").toBe(true);
		expect(
			lockRuns(first.lock, process.pid),
			"a mark of the first's read as stopped while it runs",
		).toBe(true);
		second();
		expect(
			lockRuns(first.lock, process.pid),
			"a mark of the first's read as stopped once the second let go",
		).toBe(true);
		expect(
			lockRuns(first.lock, NO_SUCH_PID),
			"a mark another process made under it read as running",
		).toBe(false);
	});

	it("leaves a sweep that let its lock go read as stopped by the next", () => {
		const lockPath = lockPathFresh();
		const first = hold(lockPath);
		first();
		hold(lockPath);

		expect(
			lockRuns(first.lock, process.pid),
			"a mark of a sweep that ended read as running",
		).toBe(false);
	});

	it("stays its holder's when its takeover can't be noted", () => {
		const lockPath = lockPathFresh();
		const first = hold(lockPath);
		stale(lockPath);
		mkdirSync(`${lockPath}.taken`);

		const second = sweepLock(lockPath, UNTOUCHED);
		if (typeof second !== "string") held.push(second);

		expect(second, "a takeover nobody noted").toEqual(
			expect.stringContaining("noting its takeover failed"),
		);
		expect(first.ours(), "the first lost a lock nobody took").toBe(true);
	});

	it("keeps only the newest takeovers noted", () => {
		const lockPath = lockPathFresh();
		const first = hold(lockPath);
		let last = first;
		// One more than are kept, so the first is the one let go.
		for (let takeover = 0; takeover < 65; takeover += 1) {
			stale(lockPath);
			last = hold(lockPath);
		}

		const noted = readFileSync(`${lockPath}.taken`, "utf8").trim().split("\n");
		expect(noted, "how many takeovers are noted").toHaveLength(64);
		expect(
			lockRuns(first.lock, process.pid),
			"the oldest takeover is kept",
		).toBe(false);
		expect(last.ours(), "the newest lost its lock").toBe(true);
	});
});
