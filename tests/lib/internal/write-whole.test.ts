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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearWriting,
	type Wanted,
	WRITING,
	wholeWrites,
	writeWhole,
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
	it("replaces it, leaving nothing staged", () => {
		const file = join(dir, "queue.json");
		writeFileSync(file, "old");

		writeWhole(file, "new");

		expect(readFileSync(file, "utf8")).toBe("new");
		expect(readdirSync(dir).sort()).toEqual([WRITING, "queue.json"]);
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
});

/** A write that waits until it is let go, one for each call, in order. */
function heldWrites() {
	const calls: { file: string; wanted: Wanted; go: () => void }[] = [];
	const write = (file: string, wanted: Wanted) =>
		new Promise<void>((resolve) => {
			calls.push({
				file,
				wanted,
				go: () => {
					if (wanted === null) rmSync(file, { force: true });
					else writeFileSync(file, wanted);
					resolve();
				},
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
		expect(held.calls.map(({ wanted }) => wanted), "one out at once").toEqual([
			"one",
		]);
		expect(writes.waiting(file), "the latest asked waits").toBe("three");

		held.calls[0]?.go();
		await vi.waitFor(() => {
			expect(held.calls.length, "the next sent once it landed").toBe(2);
		});
		expect(held.calls[1]?.wanted, "the latest, the one between passed over").toBe(
			"three",
		);
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
