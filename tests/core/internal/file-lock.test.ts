import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
			// Long enough for the second to take a lock it judged stale.
			await Promise.race([
				secondEntered,
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

	it("takes over a lock an earlier process with this pid left", async () => {
		const lock = await loadedAgain();
		const path = join(dir, "record.json");
		writeFileSync(`${path}.lock`, String(process.pid));

		await expect(lock.withFileLock(path, async () => "written")).resolves.toBe(
			"written",
		);
	});
});
