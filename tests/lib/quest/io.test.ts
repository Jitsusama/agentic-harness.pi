import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	utimesSync,
	watch,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	atomicWriteFile,
	useRunFolderForTests,
	withQuestLock,
} from "../../../lib/internal/quest/io.ts";
import { WRITING } from "../../../lib/internal/write-whole.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "quest-io-"));
	// No runtime folder unless a test makes one, whatever the machine has.
	useRunFolderForTests(join(dir, "no-run-folder"));
});

afterEach(() => {
	useRunFolderForTests(undefined);
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

	it("holds its lock in .writing where there is no runtime folder, as on the Mac", () => {
		// The Mac has no /run/user, so every writer there agrees on .writing.
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
			expect(
				existsSync(join(questDir, "ok.txt")),
				`${join(questDir, "ok.txt")} is not written`,
			).toBe(false);
		},
		15_000,
	);

	it.each([
		["its own", join(WRITING, "quest.lock")],
		["an older session's", ".quest.lock"],
	])(
		"steals %s ownerless lock once it is older than any write takes",
		(_, lockName) => {
			const questDir = join(dir, "QEST-20260603-DDD444");
			mkdirSync(join(questDir, WRITING), { recursive: true });
			const lock = join(questDir, lockName);
			writeFileSync(lock, "");
			const old = new Date(Date.now() - 60_000);
			utimesSync(lock, old, old);

			withQuestLock(questDir, () => {
				atomicWriteFile(join(questDir, "ok.txt"), "y");
			});

			expect(
				existsSync(join(questDir, "ok.txt")),
				`${join(questDir, "ok.txt")} exists`,
			).toBe(true);
			expect(readdirSync(questDir).sort()).toEqual([WRITING, "ok.txt"]);
			expect(readdirSync(join(questDir, WRITING))).toEqual([]);
		},
	);

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
		expect(
			existsSync(join(questDir, "ok.txt")),
			`${join(questDir, "ok.txt")} exists`,
		).toBe(true);
	});

	// The fence runs its commands in a pid namespace of their own, so a
	// fenced writer's pid means another process, or none, out here, and
	// the host's means another inside.
	const ownNamespace = existsSync("/proc/self/ns/pid");
	/** A pid no process has: past Linux's highest, 2^22. */
	const NO_SUCH_PID = 999_999_999;

	it.runIf(ownNamespace)("writes its pid namespace in its lock", () => {
		const questDir = join(dir, "QEST-20261117-NS0001");
		mkdirSync(questDir, { recursive: true });
		const record = withQuestLock(questDir, () =>
			JSON.parse(readFileSync(join(questDir, WRITING, "quest.lock"), "utf8")),
		);
		expect(record).toMatchObject({
			pid: process.pid,
			pidns: readlinkSync("/proc/self/ns/pid"),
		});
	});

	it.runIf(ownNamespace)(
		"waits on a fresh lock from another pid namespace, whose pid means nothing here",
		() => {
			const questDir = join(dir, "QEST-20261117-NS0002");
			mkdirSync(join(questDir, WRITING), { recursive: true });
			writeFileSync(
				join(questDir, WRITING, "quest.lock"),
				JSON.stringify({
					pid: NO_SUCH_PID,
					startedAt: Date.now(),
					pidns: "pid:[1]",
				}),
			);
			expect(() =>
				withQuestLock(questDir, () => {
					atomicWriteFile(join(questDir, "ok.txt"), "y");
				}),
			).toThrow(/Timed out/);
			expect(existsSync(join(questDir, "ok.txt")), "ok.txt not written").toBe(
				false,
			);
		},
		15_000,
	);

	it("takes over a lock from another pid namespace once it is older than any write takes", () => {
		const questDir = join(dir, "QEST-20261117-NS0003");
		mkdirSync(join(questDir, WRITING), { recursive: true });
		writeFileSync(
			join(questDir, WRITING, "quest.lock"),
			JSON.stringify({
				pid: process.pid,
				startedAt: Date.now() - 60_000,
				pidns: "pid:[1]",
			}),
		);
		withQuestLock(questDir, () => {
			atomicWriteFile(join(questDir, "ok.txt"), "y");
		});
		expect(readFileSync(join(questDir, "ok.txt"), "utf8")).toBe("y");
	});

	it("takes over a fresh lock from its own pid namespace whose owner is gone", () => {
		const questDir = join(dir, "QEST-20261117-NS0004");
		mkdirSync(join(questDir, WRITING), { recursive: true });
		const pidns = ownNamespace ? readlinkSync("/proc/self/ns/pid") : undefined;
		writeFileSync(
			join(questDir, WRITING, "quest.lock"),
			JSON.stringify({ pid: NO_SUCH_PID, startedAt: Date.now(), pidns }),
		);
		withQuestLock(questDir, () => {
			atomicWriteFile(join(questDir, "ok.txt"), "y");
		});
		expect(readFileSync(join(questDir, "ok.txt"), "utf8")).toBe("y");
	});
});

/**
 * The login's runtime folder is tmpfs, so a lock made and removed there
 * never waits on the quest disk: on 16 and 17 November the hosts' loops
 * held about 77 s in the lock's create and unlink in `.writing`, on
 * btrfs's tree lock. The machine's own runtime folder holds the session
 * bus; the fence's private one never does.
 */
describe("withQuestLock on the login's runtime folder", () => {
	let run: string;
	let bus: Server;

	beforeEach(async () => {
		run = join(dir, "run");
		mkdirSync(run);
		bus = createServer();
		await new Promise<void>((resolve) => bus.listen(join(run, "bus"), resolve));
		useRunFolderForTests(run);
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => bus.close(() => resolve()));
	});

	const locks = (): string[] => {
		const folder = join(run, "agentic-harness.pi", "quest-locks");
		return existsSync(folder) ? readdirSync(folder) : [];
	};

	const quest = (id: string): string => {
		const questDir = join(dir, id);
		mkdirSync(questDir, { recursive: true });
		return questDir;
	};

	it("holds its lock there, never in the quest's .writing", () => {
		const questDir = quest("QEST-20261117-AAA111");
		const during = withQuestLock(questDir, () => ({
			locks: locks(),
			writing: existsSync(join(questDir, WRITING, "quest.lock")),
		}));
		expect(during.locks).toHaveLength(1);
		expect(during.writing, "no lock in the quest's .writing").toBe(false);
		expect(locks()).toEqual([]);
	});

	it("never takes its folder from XDG_RUNTIME_DIR", () => {
		// A pi from cron, ssh or a bare systemd unit has no XDG_RUNTIME_DIR,
		// and two writers that pick different locks both go ahead. With the
		// lookup the machine's own, a runtime folder named only by the
		// variable is never used.
		const questDir = quest("QEST-20261117-BBB222");
		const before = process.env.XDG_RUNTIME_DIR;
		useRunFolderForTests(undefined);
		try {
			process.env.XDG_RUNTIME_DIR = run;
			const during = withQuestLock(questDir, locks);
			expect(during).toEqual([]);
		} finally {
			if (before === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = before;
		}
	});

	it("gives a quest reached by two paths one lock", () => {
		const questDir = quest("QEST-20261117-III999");
		const link = join(dir, "linked");
		symlinkSync(questDir, link);
		const direct = withQuestLock(questDir, locks);
		const linked = withQuestLock(link, locks);
		expect(direct).toHaveLength(1);
		expect(linked).toEqual(direct);
	});

	it("gives each quest a lock of its own", () => {
		const first = quest("QEST-20261117-CCC333");
		const second = quest("QEST-20261117-DDD444");
		const during = withQuestLock(first, () => withQuestLock(second, locks));
		expect(during).toHaveLength(2);
	});

	it("falls back to .writing where the runtime folder has no session bus, as inside the fence", async () => {
		await new Promise<void>((resolve) => bus.close(() => resolve()));
		bus = createServer();
		const questDir = quest("QEST-20261117-EEE555");
		const during = withQuestLock(questDir, () => ({
			locks: locks(),
			writing: readdirSync(join(questDir, WRITING)),
		}));
		expect(during).toEqual({ locks: [], writing: ["quest.lock"] });
	});

	it("locks where the fence lets the lock folder through, though it hides the bus", async () => {
		// Inside the fence the runtime folder is a private tmpfs with no
		// bus, but the lock folder is bound back in, so a fenced writer and
		// one outside take the same lock.
		const questDir = quest("QEST-20261117-JJJ000");
		const outside = withQuestLock(questDir, locks);
		await new Promise<void>((resolve) => bus.close(() => resolve()));
		bus = createServer();
		const inside = withQuestLock(questDir, () => ({
			locks: locks(),
			writing: existsSync(join(questDir, WRITING, "quest.lock")),
		}));
		expect(outside).toHaveLength(1);
		expect(inside).toEqual({ locks: outside, writing: false });
	});

	it.each([
		["with the bus", false],
		["inside the fence", true],
	])(
		"writes nothing where the lock folder is a link, %s, rather than lock alone",
		async (_, fenced) => {
			if (fenced) {
				await new Promise<void>((resolve) => bus.close(() => resolve()));
				bus = createServer();
			}
			const elsewhere = join(dir, "elsewhere");
			mkdirSync(elsewhere);
			mkdirSync(join(run, "agentic-harness.pi"));
			symlinkSync(elsewhere, join(run, "agentic-harness.pi", "quest-locks"));
			const questDir = quest("QEST-20261117-KKK111");
			expect(() =>
				withQuestLock(questDir, () => {
					atomicWriteFile(join(questDir, "ok.txt"), "y");
				}),
			).toThrow(/quest-locks/);
			expect(readdirSync(elsewhere)).toEqual([]);
			expect(existsSync(join(questDir, "ok.txt")), "ok.txt not written").toBe(
				false,
			);
		},
	);

	it("takes no bus that isn't a socket", async () => {
		await new Promise<void>((resolve) => bus.close(() => resolve()));
		bus = createServer();
		writeFileSync(join(run, "bus"), "");
		const questDir = quest("QEST-20261117-LLL222");
		const during = withQuestLock(questDir, () => ({
			locks: locks(),
			writing: readdirSync(join(questDir, WRITING)),
		}));
		expect(during).toEqual({ locks: [], writing: ["quest.lock"] });
	});

	it("takes over a stale lock in .writing", () => {
		const questDir = quest("QEST-20261117-MMM333");
		mkdirSync(join(questDir, WRITING));
		const stale = join(questDir, WRITING, "quest.lock");
		writeFileSync(stale, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(stale, old, old);
		withQuestLock(questDir, () => {
			atomicWriteFile(join(questDir, "ok.txt"), "y");
		});
		expect(readFileSync(join(questDir, "ok.txt"), "utf8")).toBe("y");
		expect(readdirSync(join(questDir, WRITING))).toEqual([]);
	});

	it("waits on a fresh lock in .writing, as a fenced writer or older code holds", () => {
		const questDir = quest("QEST-20261117-FFF666");
		mkdirSync(join(questDir, WRITING));
		writeFileSync(join(questDir, WRITING, "quest.lock"), "");
		expect(() =>
			withQuestLock(questDir, () => {
				atomicWriteFile(join(questDir, "ok.txt"), "y");
			}),
		).toThrow(/Timed out/);
		expect(locks()).toEqual([]);
		expect(existsSync(join(questDir, "ok.txt")), "ok.txt not written").toBe(
			false,
		);
	}, 15_000);

	it("waits on a fresh lock another writer holds there", () => {
		const questDir = quest("QEST-20261117-GGG777");
		const [name] = withQuestLock(questDir, locks);
		if (!name) throw new Error("no lock was taken in the runtime folder");
		writeFileSync(join(run, "agentic-harness.pi", "quest-locks", name), "");
		// The lock's own name says nothing of which quest is stuck.
		expect(() =>
			withQuestLock(questDir, () => {
				atomicWriteFile(join(questDir, "ok.txt"), "y");
			}),
		).toThrow(`Timed out acquiring the lock of quest ${questDir}`);
		expect(existsSync(join(questDir, "ok.txt")), "ok.txt not written").toBe(
			false,
		);
	}, 15_000);

	it("takes over an ownerless lock there once it is older than any write takes", () => {
		const questDir = quest("QEST-20261117-HHH888");
		const [name] = withQuestLock(questDir, locks);
		if (!name) throw new Error("no lock was taken in the runtime folder");
		const lock = join(run, "agentic-harness.pi", "quest-locks", name);
		writeFileSync(lock, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		withQuestLock(questDir, () => {
			atomicWriteFile(join(questDir, "ok.txt"), "y");
		});
		expect(readFileSync(join(questDir, "ok.txt"), "utf8")).toBe("y");
		expect(locks()).toEqual([]);
	});
});
