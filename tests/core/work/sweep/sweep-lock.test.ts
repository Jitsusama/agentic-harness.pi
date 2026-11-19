/**
 * One sweep at a time, however long it takes.
 *
 * Each case runs a real sweep over a real repository, and while that
 * sweep is inside its first git call, does what a second sweep, or
 * time, would do to its lock.
 */

import {
	existsSync,
	readFileSync,
	rmSync,
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
} from "../../../../lib/core/work/sweep-lock.ts";
import { disposeAll, exec, machine, setUp } from "../support/sweep-live.ts";

afterEach(disposeAll);

/** How often the sweeps here touch their lock, kept short to keep the cases fast. */
const FRESH_EVERY_MS = 20;

/** The age at which an untouched lock is taken over. */
const STALE_MS = 60 * 60 * 1000;

/** Older than any lock a sweep would leave standing. */
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** Date the lock as one nobody has touched for two hours. */
function age(lockPath: string): void {
	const old = new Date(Date.now() - TWO_HOURS_MS);
	utimesSync(lockPath, old, old);
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
	it("keeps its lock fresh while it runs, so a second sweep waits however long the first takes", async () => {
		const { memory, lockPath, cut } = await setUp();
		await cut("done", ["-b", "done", "@", "main"]);
		let second: SweepOutcome | undefined;

		await sweepEndedTrees({
			exec: pausingOnce(async () => {
				age(lockPath);
				// Long enough for several touches, as an hour's sweep makes many.
				await wait(FRESH_EVERY_MS * 5);
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
			lockFresh: { everyMs: FRESH_EVERY_MS, forMs: 60_000 },
		});

		expect(
			second?.skipped,
			"a second sweep took over a lock its running sweep had kept fresh",
		).toContain(String(process.pid));
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
				rmSync(lockPath);
				writeFileSync(lockPath, String(process.pid));
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
			LOCK_FRESH_EVERY_MS * 4,
			"a running sweep's lock could pass the stale age between touches",
		).toBeLessThanOrEqual(STALE_MS);
		expect(
			LOCK_FRESH_FOR_MS + STALE_MS,
			"a wedged sweep's lock goes stale at another time than six hours in",
		).toBe(6 * 60 * 60 * 1000);
	});
});
