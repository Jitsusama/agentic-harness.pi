/**
 * One sweep at a time, however long it takes.
 *
 * Each case runs a real sweep over a real repository, and while that
 * sweep is inside its first git call, does what a second sweep, or
 * time, would do to its lock.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	lutimesSync,
	readFileSync,
	renameSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	type SweepOutcome,
	sweepEndedTrees,
} from "../../../../lib/core/work/sweep.ts";
import {
	LOCK_FRESH_EVERY_MS,
	LOCK_FRESH_FOR_MS,
	SWEEP_STALE_MS,
} from "../../../../lib/core/work/sweep-lock.ts";
import { disposeAll, exec, machine, setUp } from "../support/sweep-live.ts";

afterEach(disposeAll);

/** How often the sweeps here touch their lock, kept short to keep the cases fast. */
const FRESH_EVERY_MS = 20;

/** Older than any lock a sweep would leave standing. */
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** Date the lock as one nobody has touched for two hours. */
function age(lockPath: string): void {
	const old = new Date(Date.now() - TWO_HOURS_MS);
	utimesSync(lockPath, old, old);
}

/**
 * Put another sweep's lock, naming this pid, where ours is. It is made
 * before ours goes, so it can never be given our lock's inode again.
 */
function replaceLock(lockPath: string): void {
	writeFileSync(`${lockPath}.theirs`, String(process.pid));
	renameSync(`${lockPath}.theirs`, lockPath);
}

/**
 * An exec that runs `meanwhile` once, at the sweep's first git call,
 * while the sweep holds its lock, then carries on as the real one.
 */
function pausingOnce(meanwhile: () => Promise<void>) {
	let paused = false;
	return async (command: string, args: string[]) => {
		if (!paused) {
			paused = true;
			await meanwhile();
		}
		return exec(command, args);
	};
}

describe("one sweep at a time", () => {
	it("keeps its lock fresh while it runs, so a second sweep is turned away however long the first takes", async () => {
		const { memory, lockPath, cut } = await setUp();
		await cut("done", ["-b", "done", "@", "main"]);
		const seconds: (SweepOutcome | undefined)[] = [];

		await sweepEndedTrees({
			exec: pausingOnce(async () => {
				// Three times over, as an hour's sweep is touched many times,
				// so a sweep that touched its lock only once would lose it.
				for (let round = 0; round < 3; round += 1) {
					age(lockPath);
					// Long enough for several touches.
					await wait(FRESH_EVERY_MS * 5);
					seconds.push(
						await sweepEndedTrees({
							exec,
							memory,
							claims: [],
							lockPath,
							facts: machine,
						}),
					);
				}
			}),
			memory,
			claims: [],
			lockPath,
			facts: machine,
			lockFresh: { everyMs: FRESH_EVERY_MS, forMs: 60_000 },
		});

		expect(
			seconds.map((second) => second?.skipped),
			"a second sweep took over a lock its running sweep had kept fresh",
		).toEqual(
			[1, 2, 3].map(() => `another sweep is running, pid ${process.pid}`),
		);
	});

	it("stops touching a lock another sweep has taken over", async () => {
		const { memory, lockPath, cut } = await setUp();
		await cut("done", ["-b", "done", "@", "main"]);
		let agedAfterTicks: number | undefined;

		await sweepEndedTrees({
			exec: pausingOnce(async () => {
				// Another sweep's lock in its place, left untouched for hours.
				replaceLock(lockPath);
				age(lockPath);
				// Past several of the touches the first sweep would make.
				await wait(FRESH_EVERY_MS * 5);
				agedAfterTicks = Date.now() - statSync(lockPath).mtimeMs;
			}),
			memory,
			claims: [],
			lockPath,
			facts: machine,
			lockFresh: { everyMs: FRESH_EVERY_MS, forMs: 60_000 },
		});

		expect(
			agedAfterTicks,
			"a sweep kept fresh a lock another sweep had made",
		).toBeGreaterThan(TWO_HOURS_MS - 60_000);
	});

	it("leaves a lock naming no pid to the sweep making it, but only for a minute", async () => {
		const { memory, lockPath, cut } = await setUp();
		const done = await cut("done", ["-b", "done", "@", "main"]);
		// Made and not yet written, as a sweep starting leaves it.
		writeFileSync(lockPath, "");

		const fresh = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});
		// Past a minute, well inside the hour a named holder's lock stands.
		const old = new Date(Date.now() - 2 * 60 * 1000);
		utimesSync(lockPath, old, old);
		const stale = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(
			fresh.skipped,
			"a sweep took over a lock another was still writing",
		).toBe("another sweep is starting");
		expect(
			stale.taken.map((tree) => tree.path),
			"an empty lock left behind kept every sweep out",
		).toEqual([done]);
	});

	it("never reads through a pipe at the lock's path", async () => {
		const { memory, lockPath } = await setUp();
		execFileSync("mkfifo", [lockPath]);

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(
			outcome.skipped,
			"a pipe at the lock's path was read as a holder",
		).toBe("another sweep is starting");
	});

	it("never removes a later lock given its lost lock's inode", async () => {
		const { memory, lockPath, cut } = await setUp();
		await cut("done", ["-b", "done", "@", "main"]);
		const ours = `${lockPath}.ours`;

		await sweepEndedTrees({
			exec: pausingOnce(async () => {
				// Taken over: another lock stands in ours' place for a few beats.
				linkSync(lockPath, ours);
				replaceLock(lockPath);
				// Long enough for several beats to see the lock is no longer ours.
				await wait(FRESH_EVERY_MS * 5);
				// Then a later lock is given our old inode, as ext4 may give it.
				renameSync(ours, lockPath);
			}),
			memory,
			claims: [],
			lockPath,
			facts: machine,
			lockFresh: { everyMs: FRESH_EVERY_MS, forMs: 60_000 },
		});

		expect(
			existsSync(lockPath),
			"a sweep that had lost its lock removed a later one with its inode",
		).toBe(true);
	});

	it("keeps watching its lock after it stops touching it", async () => {
		const { memory, lockPath, cut } = await setUp();
		await cut("done", ["-b", "done", "@", "main"]);
		const ours = `${lockPath}.ours`;

		await sweepEndedTrees({
			exec: pausingOnce(async () => {
				// Past the touching's time, so only the watching is left.
				await wait(FRESH_EVERY_MS * 4);
				linkSync(lockPath, ours);
				replaceLock(lockPath);
				// Long enough for several beats to see the lock is no longer ours.
				await wait(FRESH_EVERY_MS * 5);
				renameSync(ours, lockPath);
			}),
			memory,
			claims: [],
			lockPath,
			facts: machine,
			lockFresh: { everyMs: FRESH_EVERY_MS, forMs: FRESH_EVERY_MS * 2 },
		});

		expect(
			existsSync(lockPath),
			"a sweep past its touching removed a later lock given its old inode",
		).toBe(true);
	});

	it("takes over a dangling link left at the lock's path once it is stale", async () => {
		const { memory, lockPath, cut } = await setUp();
		const done = await cut("done", ["-b", "done", "@", "main"]);
		symlinkSync(`${lockPath}.nowhere`, lockPath);
		const old = new Date(Date.now() - TWO_HOURS_MS);
		lutimesSync(lockPath, old, old);

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(
			outcome.taken.map((tree) => tree.path),
			"a dangling link at the lock's path kept every sweep out",
		).toEqual([done]);
	});

	it("lets its lock go stale once it has kept it fresh for its time", async () => {
		const { memory, lockPath, cut } = await setUp();
		const done = await cut("done", ["-b", "done", "@", "main"]);
		let second: SweepOutcome | undefined;

		await sweepEndedTrees({
			exec: pausingOnce(async () => {
				// Past its time, as a sweep wedged for hours is.
				await wait(FRESH_EVERY_MS * 5);
				age(lockPath);
				// Past any touch it would make were it still touching.
				await wait(FRESH_EVERY_MS * 3);
				second = await sweepEndedTrees({
					exec,
					memory,
					claims: [],
					lockPath,
					facts: machine,
				});
			}),
			memory,
			claims: [],
			lockPath,
			facts: machine,
			lockFresh: { everyMs: FRESH_EVERY_MS, forMs: FRESH_EVERY_MS * 2 },
		});

		expect(second, "the second sweep never ran").toBeDefined();
		expect(
			second?.taken.map((tree) => tree.path),
			"a sweep past its time kept a second from taking its lock over and sweeping",
		).toEqual([done]);
	});

	it("leaves the lock to the sweep in its host that took it over", async () => {
		const { memory, lockPath, cut } = await setUp();
		await cut("done", ["-b", "done", "@", "main"]);

		await sweepEndedTrees({
			exec: pausingOnce(async () => {
				// Another conversation's sweep in this host takes the lock over:
				// the same pid, in a lock file of its own.
				replaceLock(lockPath);
			}),
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(
			existsSync(lockPath),
			"the sweep ending took away a lock another sweep in its host held",
		).toBe(true);
	});

	it("holds only its pid in the lock, so a session on older code reads it as held", async () => {
		const { memory, lockPath, cut } = await setUp();
		await cut("done", ["-b", "done", "@", "main"]);
		let held: string | undefined;

		await sweepEndedTrees({
			exec: pausingOnce(async () => {
				held = readFileSync(lockPath, "utf8");
			}),
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(held, "the lock held more than the sweeping pid").toBe(
			String(process.pid),
		);
	});

	it("touches its lock often enough, and long enough, that only a stopped sweep loses it", () => {
		expect(
			LOCK_FRESH_EVERY_MS,
			"a woken machine's running sweep could read as stopped for more than a minute",
		).toBeLessThanOrEqual(60 * 1000);
		expect(
			LOCK_FRESH_EVERY_MS * 4,
			"a running sweep's lock could pass the stale age between touches",
		).toBeLessThanOrEqual(SWEEP_STALE_MS);
		// Stale an hour after the last touch, which comes at the end of the
		// touching or up to a beat before it: both ends of that window fall
		// between five and a half and six hours in.
		const latest = LOCK_FRESH_FOR_MS + SWEEP_STALE_MS;
		const earliest = latest - LOCK_FRESH_EVERY_MS;
		expect(
			latest,
			"a wedged sweep's lock can go stale later than six hours in",
		).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
		expect(
			earliest,
			"a wedged sweep's lock can go stale sooner than five and a half hours in",
		).toBeGreaterThan(5.5 * 60 * 60 * 1000);
	});
});
