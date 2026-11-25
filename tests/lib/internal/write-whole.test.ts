import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearWriting,
	sayWriteFailed,
	type Wanted,
	WRITE_FAILED_ENTRY,
	WRITING,
	wholeWrites,
	writeWhole,
	writeWholeBy,
	writeWholeOff,
} from "../../../lib/internal/write-whole.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "write-whole-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("writing a file whole", () => {
	it.each([
		["writeWhole", (file: string) => writeWhole(file, "new")],
		[
			"writeWholeBy",
			(file: string) => writeWholeBy(file, (write) => write("new")),
		],
		["writeWholeOff", (file: string) => writeWholeOff(file, "new")],
	])(
		"%s stages nothing through a writing folder that is a link",
		async (_, write) => {
			const elsewhere = mkdtempSync(join(tmpdir(), "write-whole-elsewhere-"));
			try {
				symlinkSync(elsewhere, join(dir, WRITING));
				const file = join(dir, "queue.json");

				await expect(async () => write(file)).rejects.toThrow(
					/is a link or no folder/,
				);
				expect(readdirSync(elsewhere)).toEqual([]);
				expect(existsSync(file), `${file} isn't there`).toBe(false);
			} finally {
				rmSync(elsewhere, { recursive: true, force: true });
			}
		},
	);

	it.each([
		["writeWhole", (file: string) => writeWhole(file, "new")],
		[
			"writeWholeBy",
			(file: string) => writeWholeBy(file, (write) => write("new")),
		],
		["writeWholeOff", (file: string) => writeWholeOff(file, "new")],
	])(
		"%s says a writing folder that is a link to nowhere is a link",
		async (_, write) => {
			const nowhere = join(dir, "nowhere");
			symlinkSync(nowhere, join(dir, WRITING));
			const file = join(dir, "queue.json");

			await expect(async () => write(file)).rejects.toThrow(
				`${join(dir, WRITING)} is a link or no folder, so nothing is staged there.`,
			);
			expect(existsSync(nowhere), "nothing is made where it leads").toBe(false);
			expect(existsSync(file), `${file} isn't there`).toBe(false);
		},
	);

	it("replaces it, leaving nothing staged", () => {
		const file = join(dir, "queue.json");
		writeFileSync(file, "old");

		writeWhole(file, "new");

		expect(readFileSync(file, "utf8")).toBe("new");
		expect(readdirSync(dir).sort()).toEqual([WRITING, "queue.json"]);
		expect(readdirSync(join(dir, WRITING))).toEqual([]);
	});

	it("replaces it with what is written a piece at a time, leaving nothing staged", () => {
		const file = join(dir, "log.jsonl");
		writeFileSync(file, "old");

		writeWholeBy(
			file,
			(write) => {
				write("café ");
				write(Buffer.from([0xff, 0x0a]));
				write(new Uint8Array(0));
				write("end\n");
			},
			{ durable: true },
		);

		expect(readFileSync(file)).toEqual(
			Buffer.concat([
				Buffer.from("café "),
				Buffer.from([0xff, 0x0a]),
				Buffer.from("end\n"),
			]),
		);
		expect(readdirSync(join(dir, WRITING))).toEqual([]);
	});

	it("leaves it as it was, and nothing staged, when what writes the pieces throws", () => {
		const file = join(dir, "log.jsonl");
		writeFileSync(file, "old");

		expect(() =>
			writeWholeBy(file, (write) => {
				write("half");
				throw new Error("the source went");
			}),
		).toThrow("the source went");

		expect(readFileSync(file, "utf8")).toBe("old");
		expect(readdirSync(join(dir, WRITING))).toEqual([]);
	});

	it("leaves it as it was, and nothing staged, when what writes the pieces answers a promise", () => {
		const file = join(dir, "log.jsonl");
		writeFileSync(file, "old");

		expect(() =>
			writeWholeBy(file, async (write) => {
				write("half");
			}),
		).toThrow("what fills it answered a promise");

		expect(readFileSync(file, "utf8")).toBe("old");
		expect(readdirSync(join(dir, WRITING))).toEqual([]);
	});
});

describe("clearing what a writer left", () => {
	it("takes what is older than the time and keeps the rest", () => {
		const writing = join(dir, WRITING);
		mkdirSync(writing);
		writeFileSync(join(writing, "old"), "");
		writeFileSync(join(writing, "new"), "");
		const hourAgo = new Date(Date.now() - 3_600_000);
		utimesSync(join(writing, "old"), hourAgo, hourAgo);

		clearWriting(dir, Date.now() - 60_000);

		expect(readdirSync(writing)).toEqual(["new"]);
	});

	it("does nothing in a folder with no writing", () => {
		expect(() => clearWriting(dir, Date.now())).not.toThrow();
	});
});

describe("writing a file whole off the thread", () => {
	it("replaces it, making its folder and leaving nothing staged", async () => {
		const file = join(dir, "presence", "a.json");

		await writeWholeOff(file, "new");

		expect(readFileSync(file, "utf8")).toBe("new");
		expect(readdirSync(join(dir, "presence", WRITING))).toEqual([]);
	});

	it("drops what it staged, leaving the file as it was, once its signal aborts", async () => {
		const file = join(dir, "a.json");
		writeFileSync(file, "old");
		const letGo = new AbortController();
		letGo.abort();

		const written = await writeWholeOff(file, "new", { signal: letGo.signal });

		expect([
			written,
			readFileSync(file, "utf8"),
			readdirSync(join(dir, WRITING)),
		]).toEqual([false, "old", []]);
	});
});

/**
 * A write that waits until it is let go, or failed, one for each call,
 * in order.
 */
function heldWrites() {
	const calls: {
		file: string;
		wanted: Wanted;
		go: () => void;
		fail: () => void;
	}[] = [];
	const write = (file: string, wanted: Wanted) =>
		new Promise<void>((resolve, reject) => {
			calls.push({
				file,
				wanted,
				go: () => {
					if (wanted === null) rmSync(file, { force: true });
					else writeFileSync(file, wanted);
					resolve();
				},
				fail: () => reject(new Error("EIO: the disk is gone")),
			});
		});
	return { calls, write };
}

describe("a peer's whole writes", () => {
	it("write a file only once the write before it has landed, the latest asked", async () => {
		const file = join(dir, "a.json");
		const held = heldWrites();
		const writes = wholeWrites({ write: held.write });

		writes.ask(file, "one");
		writes.ask(file, "two");
		writes.ask(file, "three");
		expect(
			held.calls.map(({ wanted }) => wanted),
			"one out at once",
		).toEqual(["one"]);
		expect(writes.waiting(file), "the latest asked waits").toBe("three");

		held.calls[0]?.go();
		await vi.waitFor(() => {
			expect(held.calls.length, "the next sent once it landed").toBe(2);
		});
		expect(
			held.calls[1]?.wanted,
			"the latest, the one between passed over",
		).toBe("three");
		held.calls[1]?.go();
		await vi.waitFor(() => {
			expect(writes.waiting(file), "nothing waits once it landed").toBe(
				undefined,
			);
		});
		expect(readFileSync(file, "utf8")).toBe("three");
		expect(held.calls.length, "nothing written twice").toBe(2);
	});

	it("write files whole by default, and take one away when asked for nothing", async () => {
		const file = join(dir, "leases", "a.json");
		const writes = wholeWrites();

		writes.ask(file, "held");
		expect(existsSync(file), "not on the asker's turn").toBe(false);
		await vi.waitFor(() => {
			expect(readFileSync(file, "utf8")).toBe("held");
		});
		expect(readdirSync(join(dir, "leases", WRITING))).toEqual([]);

		writes.ask(file, null);
		expect(writes.waiting(file), "its removal waits").toBe(null);
		await vi.waitFor(() => {
			expect(existsSync(file), "taken away").toBe(false);
		});
	});

	it("list what waits in a folder", () => {
		const held = heldWrites();
		const writes = wholeWrites({ write: held.write });
		writes.ask(join(dir, "a.json"), "a");
		writes.ask(join(dir, "b.json"), null);
		writes.ask(join(dir, "other", "c.json"), "c");

		expect([...writes.waitingIn(dir)]).toEqual([
			[join(dir, "a.json"), "a"],
			[join(dir, "b.json"), null],
		]);
	});

	it("say a failed write once, and write it again until it lands", async () => {
		const file = join(dir, "a.json");
		const failed = vi.fn();
		let tries = 0;
		const writes = wholeWrites({
			failed,
			retry: { first: 10, most: 20 },
			write: async (path, wanted) => {
				tries += 1;
				if (tries < 4) throw new Error("EIO: the disk is gone");
				writeFileSync(path, wanted ?? "");
			},
		});

		writes.ask(file, "held");
		await vi.waitFor(() => {
			expect(readFileSync(file, "utf8"), "landed in the end").toBe("held");
		});
		expect(tries, "tried until it landed").toBe(4);
		expect(failed, "said once").toHaveBeenCalledTimes(1);
		expect(failed).toHaveBeenCalledWith(file, expect.any(Error));
		expect(writes.waiting(file)).toBe(undefined);
	});

	it("settle what waits on the thread, and a write out landing after it is written over", async () => {
		const file = join(dir, "a.json");
		const stays = join(dir, "b.json");
		const held = heldWrites();
		const writes = wholeWrites({ write: held.write });
		writes.ask(file, "one");
		writes.ask(file, "ended");
		writes.ask(stays, null);
		writeFileSync(stays, "old");

		writes.settle();
		expect(readFileSync(file, "utf8"), "the latest, at once").toBe("ended");
		expect(existsSync(stays), "a removal, at once").toBe(false);
		expect(writes.waiting(file), "nothing waits").toBe(undefined);

		// The write that was out lands late, as a rename stuck in a stall.
		held.calls[0]?.go();
		await vi.waitFor(() => {
			expect(held.calls.length, "the latest written again").toBe(3);
		});
		expect(held.calls[2]?.wanted).toBe("ended");
		held.calls[2]?.go();
		expect(readFileSync(file, "utf8")).toBe("ended");
	});

	// On a reload a conversation's old runtime settles and its new one
	// writes the same files, while the old one's write may still be out.
	it("write each file in one order for the process, whichever writer asks", async () => {
		const file = join(dir, "a.json");
		const held = heldWrites();
		const old = wholeWrites({ write: held.write });
		const fresh = wholeWrites({ write: held.write });

		old.ask(file, "old");
		old.settle();
		fresh.ask(file, "new");
		expect(
			held.calls.map(({ wanted }) => wanted),
			"one out for the file, whoever asked",
		).toEqual(["old"]);
		expect(old.waiting(file), "either writer reads what waits").toBe("new");

		// The old runtime's write lands late, as a rename stuck in a stall.
		held.calls[0]?.go();
		await vi.waitFor(() => {
			expect(held.calls.length, "the newest ask written after it").toBe(2);
		});
		expect(held.calls[1]?.wanted).toBe("new");
		held.calls[1]?.go();
		await vi.waitFor(() => {
			expect(fresh.waiting(file)).toBe(undefined);
		});
		expect(readFileSync(file, "utf8"), "the new runtime's, last").toBe("new");
	});

	it("write again a file a write on the thread couldn't land", async () => {
		// A file where its folder should be, so no write can land there.
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "");
		const file = join(blocked, "a.json");
		const writes = wholeWrites({ retry: { first: 10, most: 10 } });

		expect(() => writes.now(file, "ended")).toThrow();
		expect(writes.waiting(file), "it still waits").toBe("ended");
		rmSync(blocked);

		await vi.waitFor(() => {
			expect(readFileSync(file, "utf8"), "landed once it could").toBe("ended");
		});
	});

	it("say nothing of a write out that failed once a settle landed its file", async () => {
		const file = join(dir, "a.json");
		const held = heldWrites();
		const failed = vi.fn();
		const writes = wholeWrites({
			failed,
			retry: { first: 10, most: 10 },
			write: held.write,
		});
		writes.ask(file, "ended");
		writes.settle();

		held.calls[0]?.fail();
		// Three retry spells: one would have been sent by now.
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(failed, "nothing failed that waits").not.toHaveBeenCalled();
		expect(held.calls.length, "nothing written again").toBe(1);
		expect(readFileSync(file, "utf8")).toBe("ended");
	});

	it("wait out a failing file's spell, then write the latest, the spell doubling to its most", async () => {
		vi.useFakeTimers();
		try {
			const file = join(dir, "a.json");
			const failed = vi.fn();
			const wrote: Wanted[] = [];
			const fails = new Set([1, 2, 3, 5]);
			const writes = wholeWrites({
				failed,
				retry: { first: 100, most: 200 },
				write: async (_, wanted) => {
					wrote.push(wanted);
					if (fails.has(wrote.length)) throw new Error("EIO");
				},
			});

			writes.ask(file, "one");
			await vi.advanceTimersByTimeAsync(0);
			writes.ask(file, "two");
			await vi.advanceTimersByTimeAsync(99);
			expect(wrote, "an ask in its spell waits for it").toEqual(["one"]);
			await vi.advanceTimersByTimeAsync(1);
			expect(wrote, "then the latest").toEqual(["one", "two"]);
			await vi.advanceTimersByTimeAsync(199);
			expect(wrote.length, "the spell doubled").toBe(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(wrote.length).toBe(3);
			await vi.advanceTimersByTimeAsync(200);
			expect(wrote.length, "held to its most").toBe(4);
			expect(writes.waiting(file), "landed").toBe(undefined);
			expect(failed, "said once while it failed").toHaveBeenCalledTimes(1);

			writes.ask(file, "three");
			await vi.advanceTimersByTimeAsync(0);
			expect(failed, "a new failure, said again").toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(100);
			expect(wrote.length, "from its first spell again").toBe(6);
		} finally {
			vi.useRealTimers();
		}
	});

	it("write one at once on the thread, over a write still out", async () => {
		const file = join(dir, "a.json");
		const held = heldWrites();
		const writes = wholeWrites({ write: held.write });
		writes.ask(file, "one");

		writes.now(file, null);
		expect(writes.waiting(file), "nothing waits").toBe(undefined);

		held.calls[0]?.go();
		await vi.waitFor(() => {
			expect(held.calls.length, "its removal said again").toBe(2);
		});
		expect(held.calls[1]?.wanted).toBe(null);
		held.calls[1]?.go();
		expect(existsSync(file), "gone, as asked last").toBe(false);
	});
});

describe("a write that couldn't land, said", () => {
	it("goes in the session's log and on standard error, a host's journal", () => {
		const append = vi.fn();
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			sayWriteFailed(append)("/mesh/presence/a.json", new Error("EIO: gone"));

			expect(append).toHaveBeenCalledWith(WRITE_FAILED_ENTRY, {
				file: "/mesh/presence/a.json",
				error: "EIO: gone",
			});
			expect(stderr).toHaveBeenCalledWith(
				expect.stringMatching(/\/mesh\/presence\/a\.json.*EIO: gone/),
			);
		} finally {
			stderr.mockRestore();
		}
	});
});
