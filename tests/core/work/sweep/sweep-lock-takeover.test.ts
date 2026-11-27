/**
 * A sweep lock taken over from a sweep that still runs: that sweep may
 * wake mid-removal, so what it marked must go on standing, while a sweep
 * that ended and let its lock go leaves its marks to read as stopped.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type HeldSweepLock,
	lockRuns,
	type RemovalLock,
	SWEEP_STALE_MS,
	sweepLock,
	TAKEN_STANDS_MS,
} from "../../../../lib/core/work/sweep-lock.ts";
import { NO_SUCH_PID } from "../support/sweep-live.ts";

/** Beats too far apart to touch the lock while a case runs. */
const UNTOUCHED = { everyMs: 60_000, forMs: 60_000 };

const dirs: string[] = [];
const held: HeldSweepLock[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill();
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

/** Date the lock as one nobody has touched for `ms`, two hours unless said. */
function stale(lockPath: string, ms = 2 * 60 * 60 * 1000): void {
	const old = new Date(Date.now() - ms);
	utimesSync(lockPath, old, old);
}

/**
 * A lock at `lockPath` held by a sweep in another process, one that
 * runs until the case ends, as a sweep in another host's would be, so
 * the pid a takeover notes is not the taker's own.
 */
function heldElsewhere(lockPath: string): { lock: RemovalLock; pid: number } {
	const child = spawn("sleep", ["60"], { stdio: "ignore" });
	children.push(child);
	const pid = child.pid;
	if (pid === undefined) throw new Error("the holder didn't start");
	writeFileSync(lockPath, String(pid), { flag: "wx" });
	return { lock: { path: lockPath, id: identity(lockPath) }, pid };
}

/** Which file stands at `path`, as the lock knows its own. */
function identity(path: string): string {
	const stats = statSync(path);
	return `${stats.dev}/${stats.ino}`;
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
		// Held elsewhere, so the next lock reads as another's even when it is
		// given the first's inode, as ext4 and XFS often do.
		const first = heldElsewhere(lockPath);
		rmSync(lockPath);
		hold(lockPath);

		expect(
			lockRuns(first.lock, first.pid),
			"a mark of a sweep that let go read as running",
		).toBe(false);
	});

	it("notes the pid that held it, not the taker's", () => {
		const lockPath = lockPathFresh();
		const first = heldElsewhere(lockPath);
		stale(lockPath);
		hold(lockPath);

		expect(
			lockRuns(first.lock, first.pid),
			"a mark of the taken sweep's read as stopped while it runs",
		).toBe(true);
		expect(
			lockRuns(first.lock, process.pid),
			"a mark the taker never made under it read as running",
		).toBe(false);
	});

	it("stands for a taken mark when a later lock has its inode", () => {
		const lockPath = lockPathFresh();
		const later = hold(lockPath);
		const taken = heldElsewhere(`${lockPath}.elsewhere`);
		// The note a takeover of a lock that was this inode would have left,
		// once its aside went and the later lock was given the inode again.
		writeFileSync(
			`${lockPath}.taken`,
			`${later.lock.id} ${taken.pid} ${Date.now()}\n`,
		);

		expect(
			lockRuns({ path: lockPath, id: later.lock.id }, taken.pid),
			"a taken sweep's mark read as stopped beside a lock with its inode",
		).toBe(true);
	});

	it("lets a taken sweep's marks go once its takeover is old", () => {
		const lockPath = lockPathFresh();
		const first = heldElsewhere(lockPath);
		stale(lockPath);
		hold(lockPath);
		const later = Date.now() + TAKEN_STANDS_MS + 60_000;

		expect(
			lockRuns(first.lock, first.pid, later),
			"a wedged sweep's mark stood past its takeover's time",
		).toBe(false);
	});

	it("is taken over unnoted once a note would have run out", () => {
		const lockPath = lockPathFresh();
		const first = hold(lockPath);
		stale(lockPath, SWEEP_STALE_MS + TAKEN_STANDS_MS + 60_000);
		mkdirSync(`${lockPath}.taken`);

		const second = sweepLock(lockPath, UNTOUCHED);
		if (typeof second === "string") throw new Error(second);
		held.push(second);

		expect(first.ours(), "the first kept a lock past every note").toBe(false);
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
