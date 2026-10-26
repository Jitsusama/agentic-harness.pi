import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	atomicWriteFile,
	withQuestLock,
} from "../../../lib/core/internal/quest/io.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "quest-io-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
	it("writes content to the target path", () => {
		const path = join(dir, "out.txt");
		atomicWriteFile(path, "hello");
		expect(readFileSync(path, "utf8")).toBe("hello");
	});

	it("leaves no .tmp- artifacts on a successful write", () => {
		const path = join(dir, "out.txt");
		atomicWriteFile(path, "hello");
		const remaining = readdirSync(dir).filter((n) => n.includes(".tmp-"));
		expect(remaining).toHaveLength(0);
	});

	it("replaces an existing file (rename, not append)", () => {
		const path = join(dir, "out.txt");
		writeFileSync(path, "old");
		atomicWriteFile(path, "new");
		expect(readFileSync(path, "utf8")).toBe("new");
	});
});

describe("withQuestLock", () => {
	it("serializes two concurrent mutations against the same quest dir", async () => {
		const questDir = join(dir, "QEST-20260603-AAA111");
		mkdirSync(questDir, { recursive: true });
		const counter = join(questDir, "counter.txt");
		writeFileSync(counter, "0");
		// Two parallel mutators: each reads the current value
		// and writes value+1 inside the locked section. Without
		// the lock, two concurrent readers would both see 0
		// and write 1, losing one increment.
		const bumpOnce = (): Promise<void> =>
			new Promise((resolve) => {
				setImmediate(() => {
					withQuestLock(questDir, () => {
						const v = Number.parseInt(readFileSync(counter, "utf8"), 10);
						// A tiny pause to widen the race window.
						const until = Date.now() + 5;
						while (Date.now() < until) {
							// spin
						}
						atomicWriteFile(counter, String(v + 1));
					});
					resolve();
				});
			});
		await Promise.all([bumpOnce(), bumpOnce(), bumpOnce()]);
		expect(readFileSync(counter, "utf8")).toBe("3");
	});

	it("waits on a fresh lock that has no owner written yet", () => {
		// A holder creates the lock and then writes its pid, so for a
		// moment every lock is empty. Reading that as abandoned took a
		// live lock out from under its holder.
		const questDir = join(dir, "QEST-20260603-CCC333");
		mkdirSync(questDir, { recursive: true });
		writeFileSync(join(questDir, ".quest.lock"), "");

		expect(() =>
			withQuestLock(questDir, () => {
				atomicWriteFile(join(questDir, "ok.txt"), "y");
			}),
		).toThrow(/Timed out/);
		expect(existsSync(join(questDir, "ok.txt"))).toBe(false);
	}, 15_000);

	it("steals an ownerless lock once it is older than any write takes", () => {
		const questDir = join(dir, "QEST-20260603-DDD444");
		mkdirSync(questDir, { recursive: true });
		const lock = join(questDir, ".quest.lock");
		writeFileSync(lock, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);

		withQuestLock(questDir, () => {
			atomicWriteFile(join(questDir, "ok.txt"), "y");
		});

		expect(existsSync(join(questDir, "ok.txt"))).toBe(true);
		expect(readdirSync(questDir).sort()).toEqual(["ok.txt"]);
	});

	it("steals an obviously stale lock from a dead owner", () => {
		const questDir = join(dir, "QEST-20260603-BBB222");
		mkdirSync(questDir, { recursive: true });
		// Plant a lock file owned by an impossible pid with a
		// startedAt well past STALE_LOCK_MS so the steal path
		// fires.
		writeFileSync(
			join(questDir, ".quest.lock"),
			JSON.stringify({ pid: 1, startedAt: Date.now() - 60_000 }),
		);
		expect(() =>
			withQuestLock(questDir, () => {
				atomicWriteFile(join(questDir, "ok.txt"), "y");
			}),
		).not.toThrow();
		expect(existsSync(join(questDir, "ok.txt"))).toBe(true);
	});
});
