import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWriteFile, withQuestLock } from "../../../lib/internal/quest/io";
import { WRITING } from "../../../lib/internal/write-whole";

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

	it("makes nothing in the folder but the file and its .writing", () => {
		// The shell watches some quest folders, and every name made or
		// removed there wakes it.
		const path = join(dir, "out.txt");
		atomicWriteFile(path, "hello");
		atomicWriteFile(path, "again");
		expect(readdirSync(dir).sort()).toEqual([WRITING, "out.txt"]);
		expect(readdirSync(join(dir, WRITING))).toEqual([]);
	});

	it("replaces an existing file (rename, not append)", () => {
		const path = join(dir, "out.txt");
		writeFileSync(path, "old");
		atomicWriteFile(path, "new");
		expect(readFileSync(path, "utf8")).toBe("new");
	});
});

/**
 * The names a watcher of `folder` hears while `act` runs, as the shell's
 * watch of a quest folder hears them. A file written after `act` marks
 * the end: events come in order, so once it is heard all of `act`'s are.
 */
async function heardDuring(folder: string, act: () => void): Promise<string[]> {
	const heard: string[] = [];
	const watcher = watch(folder, (_, name) => {
		if (name) heard.push(name);
	});
	try {
		act();
		writeFileSync(join(folder, "done"), "");
		await vi.waitFor(() => expect(heard).toContain("done"));
	} finally {
		watcher.close();
	}
	return [...new Set(heard)].filter((name) => name !== "done").sort();
}

describe("what a watcher of the quest folder hears", () => {
	it("hears a write only as the file itself", async () => {
		const path = join(dir, "README.md");
		atomicWriteFile(path, "first");
		const heard = await heardDuring(dir, () => {
			atomicWriteFile(path, "second");
			atomicWriteFile(path, "third");
		});
		expect(heard).toEqual(["README.md"]);
	});

	it("hears nothing of the lock", async () => {
		const questDir = join(dir, "QEST-20260603-FFF666");
		mkdirSync(questDir, { recursive: true });
		withQuestLock(questDir, () => undefined);
		const heard = await heardDuring(questDir, () => {
			withQuestLock(questDir, () => undefined);
			withQuestLock(questDir, () => undefined);
		});
		expect(heard).toEqual([]);
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

	it("holds its lock in .writing, never in the quest folder", () => {
		const questDir = join(dir, "QEST-20260603-EEE555");
		mkdirSync(questDir, { recursive: true });
		const during = withQuestLock(questDir, () => ({
			folder: readdirSync(questDir).sort(),
			writing: readdirSync(join(questDir, WRITING)),
		}));
		expect(during).toEqual({ folder: [WRITING], writing: ["quest.lock"] });
		expect(readdirSync(join(questDir, WRITING))).toEqual([]);
	});

	it.each([
		["its own", join(WRITING, "quest.lock")],
		["an older session's", ".quest.lock"],
	])(
		"waits on %s fresh lock that has no owner written yet",
		(_, lockName) => {
			// A holder creates the lock and then writes its pid, so for a
			// moment every lock is empty. Reading that as abandoned took a
			// live lock out from under its holder. Sessions on code from
			// before 31 October lock in the quest folder itself.
			const questDir = join(dir, "QEST-20260603-CCC333");
			mkdirSync(join(questDir, WRITING), { recursive: true });
			writeFileSync(join(questDir, lockName), "");

			expect(() =>
				withQuestLock(questDir, () => {
					atomicWriteFile(join(questDir, "ok.txt"), "y");
				}),
			).toThrow(/Timed out/);
			expect(existsSync(join(questDir, "ok.txt"))).toBe(false);
		},
		15_000,
	);

	it.each([
		["its own", join(WRITING, "quest.lock")],
		["an older session's", ".quest.lock"],
	])("steals %s ownerless lock once it is older than any write takes", (_, lockName) => {
		const questDir = join(dir, "QEST-20260603-DDD444");
		mkdirSync(join(questDir, WRITING), { recursive: true });
		const lock = join(questDir, lockName);
		writeFileSync(lock, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);

		withQuestLock(questDir, () => {
			atomicWriteFile(join(questDir, "ok.txt"), "y");
		});

		expect(existsSync(join(questDir, "ok.txt"))).toBe(true);
		expect(readdirSync(questDir).sort()).toEqual([WRITING, "ok.txt"]);
		expect(readdirSync(join(questDir, WRITING))).toEqual([]);
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
