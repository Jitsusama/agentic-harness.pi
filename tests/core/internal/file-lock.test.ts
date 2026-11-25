import {
	mkdtempSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** How long the first holder keeps the lock for the second to try it. */
const HELD_MS = 500;

type Lock = typeof import("../../../lib/core/internal/file-lock.ts");

/** A fresh copy of the module, as pi loads one for each conversation. */
async function loadedAgain(): Promise<Lock> {
	vi.resetModules();
	return import("../../../lib/core/internal/file-lock.ts");
}

describe("withFileLock", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "file-lock-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps two copies of itself in one process from writing at once", async () => {
		const first = await loadedAgain();
		const second = await loadedAgain();
		const path = join(dir, "record.json");
		const said: string[] = [];
		let secondIn: () => void = () => undefined;
		const secondEntered = new Promise<void>((done) => {
			secondIn = done;
		});
		let secondWrote: Promise<void> | undefined;

		await first.withFileLock(path, async () => {
			said.push("first in");
			secondWrote = second.withFileLock(path, async () => {
				said.push("second in");
				secondIn();
			});
			await Promise.race([
				secondEntered,
				// A real pause is the point: nothing says the second stayed out,
				// so the first holds long enough for it to take a lock it judged
				// stale, and lets go at once if it does.
				new Promise((done) => setTimeout(done, HELD_MS)),
			]);
			said.push("first out");
		});
		await secondWrote;

		expect(said, "the second writes only once the first is done").toEqual([
			"first in",
			"first out",
			"second in",
		]);
	});

	it("says a lock a live process keeps past the wait is held, in a way any copy reads", async () => {
		const lock = await loadedAgain();
		const other = await loadedAgain();
		const path = join(dir, "record.json");
		// The parent runs as long as this test does, and is not this pid.
		writeFileSync(`${path}.lock`, String(process.ppid));
		// Only the date is faked, so the lock's own retries still run.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const written = lock.withFileLock(path, async () => "written");
			const failed = written.then(
				() => undefined,
				(error: unknown) => error,
			);
			// A real pause lets the first attempt fix its deadline before the
			// date passes it.
			await new Promise((done) => setTimeout(done, 100));
			vi.setSystemTime(Date.now() + 11_000);
			const error = await failed;

			expect(String(error), "it wrote, or failed some other way").toMatch(
				/has been held for over 10s/,
			);
			expect(other.isLockHeld(error), "another copy can't tell").toBe(true);
			expect(
				lock.isLockHeld(new Error("EACCES: permission denied")),
				"any failure reads as a held lock",
			).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps waiting while the lock changes hands, and says a line that never lets it in is busy", async () => {
		const lock = await loadedAgain();
		const path = join(dir, "record.json");
		const lockPath = `${path}.lock`;
		// A fresh file each time is a new holder: what many rounds taking
		// the line in turn look like to one waiting on it. Made at the faked
		// date, as a real one is made at the real one, so it is never stale.
		const nextHolder = () => {
			unlinkSync(lockPath);
			writeFileSync(lockPath, String(process.ppid));
			const made = new Date();
			utimesSync(lockPath, made, made);
		};
		writeFileSync(lockPath, String(process.ppid));
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			let settled: unknown = "waiting";
			const written = lock.withFileLock(path, async () => "written");
			written.then(
				(value) => {
					settled = value;
				},
				(error: unknown) => {
					settled = error;
				},
			);
			// Each real pause lets the writer's retries, 20 ms apart, see what
			// the step before it did.
			const look = () => new Promise((done) => setTimeout(done, 100));
			await look();
			for (let hand = 0; hand < 3; hand += 1) {
				vi.setSystemTime(Date.now() + 8_000);
				nextHolder();
				await look();
			}
			expect(
				settled,
				"24 s of holders 8 s each counted as one held past 10 s",
			).toBe("waiting");

			vi.setSystemTime(Date.now() + 120_000);
			nextHolder();
			await look();
			expect(String(settled), "it wrote, or blamed one holder").toMatch(
				/changed hands 4 times/,
			);
			expect(lock.isLockHeld(settled), "a busy line reads as broken").toBe(
				true,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("writes once the holders stop taking the lock", async () => {
		const lock = await loadedAgain();
		const path = join(dir, "record.json");
		const lockPath = `${path}.lock`;
		writeFileSync(lockPath, String(process.ppid));
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const written = lock.withFileLock(path, async () => "written");
			// A real pause, as above, so the retries see each step.
			await new Promise((done) => setTimeout(done, 100));
			vi.setSystemTime(Date.now() + 8_000);
			unlinkSync(lockPath);
			writeFileSync(lockPath, String(process.ppid));
			await new Promise((done) => setTimeout(done, 100));
			vi.setSystemTime(Date.now() + 8_000);
			unlinkSync(lockPath);

			await expect(written).resolves.toBe("written");
		} finally {
			vi.useRealTimers();
		}
	});

	it("takes over a lock an earlier process with this pid left", async () => {
		const lock = await loadedAgain();
		const path = join(dir, "record.json");
		writeFileSync(`${path}.lock`, String(process.pid));

		await expect(lock.withFileLock(path, async () => "written")).resolves.toBe(
			"written",
		);
	});
});
