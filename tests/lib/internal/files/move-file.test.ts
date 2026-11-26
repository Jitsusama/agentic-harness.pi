/**
 * A file moved whole between two folders, by rename where both lie on
 * one volume and by a copy beside its place where they don't, as a btrfs
 * subvolume answers a rename from outside it.
 */

import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
	symlinkSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moveFile } from "../../../../lib/internal/files/move-file.ts";

/** The folders that are volumes of their own, which a rename can't cross. */
const volumes = vi.hoisted((): string[] => []);

/** Every rename made, as from and to, in order. */
const renames = vi.hoisted((): [string, string][] => []);

/** What happens at each read of a copy, in order, one each. */
const duringCopy = vi.hoisted((): (() => void)[] => []);

/**
 * The bytes free on every volume, a multiple of its block size, or the
 * disk's own answer when unset.
 */
const room = vi.hoisted((): { free?: bigint } => ({}));

/** What happens just before each open, in order, one each. */
const atOpen = vi.hoisted((): (() => void)[] => []);

/** Each rename's new place and each fsync's path, in order. */
const durable = vi.hoisted((): string[] => []);

/** The path each open descriptor was opened at. */
const opened = vi.hoisted(() => new Map<number, string>());

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const volumeOf = (path: string) =>
		volumes.find((volume) => path.startsWith(`${volume}/`)) ?? "";
	return {
		...real,
		renameSync: (...args: Parameters<typeof real.renameSync>) => {
			const [from, to] = [String(args[0]), String(args[1])];
			renames.push([from, to]);
			if (volumeOf(from) !== volumeOf(to)) {
				throw Object.assign(
					new Error(`EXDEV: cross-device link not permitted, rename '${from}'`),
					{ code: "EXDEV" },
				);
			}
			real.renameSync(...args);
			durable.push(`rename ${to}`);
		},
		openSync: (...args: Parameters<typeof real.openSync>) => {
			atOpen.shift()?.();
			const fd = real.openSync(...args);
			opened.set(fd, String(args[0]));
			return fd;
		},
		fsyncSync: (fd: number) => {
			real.fsyncSync(fd);
			durable.push(`fsync ${opened.get(fd)}`);
		},
		readSync: (...args: unknown[]) => {
			duringCopy.shift()?.();
			return (real.readSync as (...all: unknown[]) => number)(...args);
		},
		statfsSync: (path: string, options?: { bigint?: boolean }) => {
			const found = real.statfsSync(path, { bigint: true });
			const { free } = room;
			const said =
				free === undefined ? found : { ...found, bavail: free / found.bsize };
			return options?.bigint
				? said
				: Object.fromEntries(
						Object.entries(said).map(([key, value]) => [key, Number(value)]),
					);
		},
	};
});

const made: string[] = [];
afterEach(() => {
	volumes.length = 0;
	renames.length = 0;
	duringCopy.length = 0;
	room.free = undefined;
	atOpen.length = 0;
	durable.length = 0;
	opened.clear();
	for (const path of made.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

/** Two folders, each a volume of its own unless `oneVolume`. */
function twoFolders(oneVolume = false): { here: string; there: string } {
	const root = mkdtempSync(join(tmpdir(), "move-file-"));
	made.push(root);
	const here = join(root, "here");
	const there = join(root, "there");
	mkdirSync(here);
	mkdirSync(there);
	if (!oneVolume) volumes.push(here, there);
	return { here, there };
}

/**
 * Waits until the clock the kernel stamps files with has passed `path`'s
 * change time, which it reads only at each tick, so a change made now
 * stamps another time.
 */
function untilChangeTimePasses(path: string): void {
	const was = statSync(path, { bigint: true }).ctimeNs;
	const probe = join(made[0] ?? "", "clock-probe");
	writeFileSync(probe, "");
	let mode = 0o600;
	while (statSync(probe, { bigint: true }).ctimeNs <= was) {
		mode ^= 0o040;
		chmodSync(probe, mode);
	}
	rmSync(probe);
}

describe("moving a file whole", () => {
	it("renames it where both folders lie on one volume", () => {
		const { here, there } = twoFolders(true);
		writeFileSync(join(here, "log.jsonl"), "kept\n");

		moveFile(join(here, "log.jsonl"), join(there, "log.jsonl"));

		expect(renames).toEqual([
			[join(here, "log.jsonl"), join(there, "log.jsonl")],
		]);
		expect(readFileSync(join(there, "log.jsonl"), "utf8")).toBe("kept\n");
		expect(readdirSync(here)).toEqual([]);
	});

	it("copies it beside its place and renames it in across volumes, keeping its bytes and mode", () => {
		const { here, there } = twoFolders();
		const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, "carried\n");
		writeFileSync(join(here, "log.jsonl"), bytes);
		// Bits a umask would clip at the open, and setuid, which never goes.
		chmodSync(join(here, "log.jsonl"), 0o4766);

		moveFile(join(here, "log.jsonl"), join(there, "log.jsonl"));

		expect(
			readFileSync(join(there, "log.jsonl")).equals(bytes),
			"the moved log has the same bytes",
		).toBe(true);
		expect(statSync(join(there, "log.jsonl")).mode & 0o7777).toBe(0o766);
		expect(readdirSync(here), "the original is gone").toEqual([]);
		expect(readdirSync(there), "nothing is left beside it").toEqual([
			"log.jsonl",
		]);
		const last = renames.at(-1);
		expect(last?.[1], "the copy is renamed into its place").toBe(
			join(there, "log.jsonl"),
		);
		expect(last?.[0].startsWith(`${there}/`), "from beside its place").toBe(
			true,
		);
	});

	it("syncs its new folder after the copy is renamed in, so a crash keeps the name", () => {
		const { here, there } = twoFolders();
		writeFileSync(join(here, "log.jsonl"), "carried\n");

		moveFile(join(here, "log.jsonl"), join(there, "log.jsonl"));

		expect(durable.slice(-2)).toEqual([
			`rename ${join(there, "log.jsonl")}`,
			`fsync ${there}`,
		]);
	});

	it("replaces what stands at its place across volumes", () => {
		const { here, there } = twoFolders();
		writeFileSync(join(here, "done.json"), "new\n");
		writeFileSync(join(there, "done.json"), "old\n");

		moveFile(join(here, "done.json"), join(there, "done.json"));

		expect(readFileSync(join(there, "done.json"), "utf8")).toBe("new\n");
		expect(readdirSync(there)).toEqual(["done.json"]);
	});

	it("moves a link as a link across volumes, never reading what it points at", () => {
		const { here, there } = twoFolders();
		const victim = join(made[0] ?? "", "victim.txt");
		writeFileSync(victim, "secret\n");
		symlinkSync(victim, join(here, "planted"));

		moveFile(join(here, "planted"), join(there, "planted"));

		expect(
			lstatSync(join(there, "planted")).isSymbolicLink(),
			"the moved link is still a link",
		).toBe(true);
		expect(readlinkSync(join(there, "planted"))).toBe(victim);
		expect(readdirSync(here)).toEqual([]);
		expect(readFileSync(victim, "utf8"), "what it points at stays").toBe(
			"secret\n",
		);
	});

	it("leaves the original where its folder is swapped for a link during the copy", () => {
		const { here, there } = twoFolders();
		const hand = join(here, "hand");
		mkdirSync(hand);
		writeFileSync(join(hand, "log.jsonl"), "planted\n");
		const outside = join(made[0] ?? "", "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "log.jsonl"), "outside\n");
		duringCopy.push(() => {
			renameSync(hand, `${hand}-was`);
			symlinkSync(outside, hand);
		});

		expect(() =>
			moveFile(join(hand, "log.jsonl"), join(there, "log.jsonl")),
		).toThrow("names another file");

		expect(readFileSync(join(outside, "log.jsonl"), "utf8")).toBe("outside\n");
		expect(readFileSync(join(there, "log.jsonl"), "utf8")).toBe("planted\n");
	});

	it("refuses a file that grows at every read, reading no further than its length when opened", () => {
		const { here, there } = twoFolders();
		const bytes = Buffer.alloc(3 * 1024 * 1024, "carried\n");
		writeFileSync(join(here, "log.jsonl"), bytes);
		for (let read = 0; read < 20; read++) {
			duringCopy.push(() => appendFileSync(join(here, "log.jsonl"), "more\n"));
		}

		expect(() =>
			moveFile(join(here, "log.jsonl"), join(there, "log.jsonl")),
		).toThrow("changed while it was copied");

		expect(
			duringCopy.length,
			"three reads of its length and one past it, never the rest",
		).toBe(16);
		expect(readdirSync(there)).toEqual([]);
	});

	it("refuses a file that shrinks during the copy, leaving nothing beside its place", () => {
		const { here, there } = twoFolders();
		writeFileSync(join(here, "log.jsonl"), Buffer.alloc(3 * 1024 * 1024, "x"));
		duringCopy.push(() => {});
		duringCopy.push(() => truncateSync(join(here, "log.jsonl"), 1024));

		expect(() =>
			moveFile(join(here, "log.jsonl"), join(there, "log.jsonl")),
		).toThrow("changed while it was copied");

		expect(readFileSync(join(here, "log.jsonl")).length).toBe(1024);
		expect(readdirSync(there)).toEqual([]);
	});

	it("refuses a file rewritten to the same length during the copy", () => {
		const { here, there } = twoFolders();
		const path = join(here, "log.jsonl");
		writeFileSync(path, "before\n");
		// Stamped well before, so the rewrite's stamp differs at any clock tick.
		utimesSync(path, 1_000_000, 1_000_000);
		duringCopy.push(() => writeFileSync(path, "after!\n"));

		expect(() => moveFile(path, join(there, "log.jsonl"))).toThrow(
			"changed while it was copied",
		);

		expect(readFileSync(path, "utf8")).toBe("after!\n");
		expect(readdirSync(there)).toEqual([]);
	});

	it("refuses a file rewritten to the same length and stamped back during the copy", () => {
		const { here, there } = twoFolders();
		const path = join(here, "log.jsonl");
		writeFileSync(path, "before\n");
		// A whole second, so putting it back puts back every nanosecond.
		utimesSync(path, 1_000_000, 1_000_000);
		duringCopy.push(() => {
			untilChangeTimePasses(path);
			writeFileSync(path, "after!\n");
			// Its modification time put back; only its change time still moves.
			utimesSync(path, 1_000_000, 1_000_000);
		});

		expect(() => moveFile(path, join(there, "log.jsonl"))).toThrow(
			"changed while it was copied",
		);

		expect(readdirSync(there)).toEqual([]);
	});

	it("refuses a file longer than the most it is asked to copy, as a planted sparse one is, writing nothing", () => {
		const { here, there } = twoFolders();
		const path = join(here, "log.jsonl");
		writeFileSync(path, "");
		truncateSync(path, 1024 ** 3);

		expect(() => moveFile(path, join(there, "log.jsonl"), 4096)).toThrow(
			"more than the 4096 a move copies",
		);

		expect(readdirSync(there)).toEqual([]);
		expect(statSync(path).size, "the original stays").toBe(1024 ** 3);
	});

	it("copies a file just as long as the most it is asked to copy", () => {
		const { here, there } = twoFolders();
		writeFileSync(join(here, "log.jsonl"), Buffer.alloc(4096, "x"));

		moveFile(join(here, "log.jsonl"), join(there, "log.jsonl"), 4096);

		expect(statSync(join(there, "log.jsonl")).size).toBe(4096);
	});

	it("refuses a file longer than the room left on its new volume", () => {
		const { here, there } = twoFolders();
		const block = BigInt(statfsSync(here).bsize);
		writeFileSync(join(here, "log.jsonl"), Buffer.alloc(Number(block * 2n)));
		room.free = block;

		expect(() =>
			moveFile(join(here, "log.jsonl"), join(there, "log.jsonl")),
		).toThrow("has room for");

		expect(readdirSync(there)).toEqual([]);
	});

	it("copies a file just as long as the room left on its new volume", () => {
		const { here, there } = twoFolders();
		const block = BigInt(statfsSync(here).bsize);
		writeFileSync(join(here, "log.jsonl"), Buffer.alloc(Number(block * 2n)));
		room.free = block * 2n;

		moveFile(join(here, "log.jsonl"), join(there, "log.jsonl"));

		expect(statSync(join(there, "log.jsonl")).size).toBe(Number(block * 2n));
	});

	it("refuses its new folder swapped for a pipe before the sync, without waiting on it, leaving the original", () => {
		const { here, there } = twoFolders();
		writeFileSync(join(here, "log.jsonl"), "carried\n");
		// The source, then the copy beside its place, then the folder synced.
		atOpen.push(
			() => {},
			() => {},
			() => {
				renameSync(there, `${there}-was`);
				expect(spawnSync("mkfifo", [there]).status, "a pipe is made").toBe(0);
			},
		);

		expect(() =>
			moveFile(join(here, "log.jsonl"), join(there, "log.jsonl")),
		).toThrow();

		expect(readFileSync(join(here, "log.jsonl"), "utf8")).toBe("carried\n");
		expect(readFileSync(join(`${there}-was`, "log.jsonl"), "utf8")).toBe(
			"carried\n",
		);
	});

	it("refuses a folder across volumes, leaving it and nothing beside its place", () => {
		const { here, there } = twoFolders();
		mkdirSync(join(here, "trees"));
		writeFileSync(join(here, "trees", "kept.txt"), "kept\n");

		expect(() => moveFile(join(here, "trees"), join(there, "trees"))).toThrow(
			"isn't a file or a link",
		);

		expect(readdirSync(join(here, "trees"))).toEqual(["kept.txt"]);
		expect(readdirSync(there)).toEqual([]);
	});

	it("refuses a pipe across volumes without waiting on it, leaving it and nothing beside its place", () => {
		const { here, there } = twoFolders();
		const pipe = join(here, "log.jsonl");
		expect(spawnSync("mkfifo", [pipe]).status, "a pipe is made").toBe(0);

		expect(() => moveFile(pipe, join(there, "log.jsonl"))).toThrow(
			"isn't a file or a link",
		);

		expect(lstatSync(pipe).isFIFO(), "the pipe stays").toBe(true);
		expect(readdirSync(there)).toEqual([]);
	});

	it("refuses a pipe swapped in after it was looked at, without waiting on it", () => {
		const { here, there } = twoFolders();
		const path = join(here, "log.jsonl");
		writeFileSync(path, "carried\n");
		atOpen.push(() => {
			rmSync(path);
			expect(spawnSync("mkfifo", [path]).status, "a pipe is made").toBe(0);
		});

		expect(() => moveFile(path, join(there, "log.jsonl"))).toThrow(
			"isn't a file or a link",
		);

		expect(lstatSync(path).isFIFO(), "the pipe stays").toBe(true);
		expect(readdirSync(there)).toEqual([]);
	});

	it("replaces a link planted at its place across volumes, never writing through it", () => {
		const { here, there } = twoFolders();
		const victim = join(made[0] ?? "", "victim.txt");
		writeFileSync(victim, "secret\n");
		symlinkSync(victim, join(there, "done.json"));
		writeFileSync(join(here, "done.json"), "new\n");

		moveFile(join(here, "done.json"), join(there, "done.json"));

		expect(lstatSync(join(there, "done.json")).isFile(), "a file now").toBe(
			true,
		);
		expect(readFileSync(join(there, "done.json"), "utf8")).toBe("new\n");
		expect(readFileSync(victim, "utf8"), "what it pointed at stays").toBe(
			"secret\n",
		);
		expect(readdirSync(there)).toEqual(["done.json"]);
	});

	it("throws any other failure of the rename as it was, copying nothing", () => {
		const { here, there } = twoFolders(true);
		writeFileSync(join(here, "log.jsonl"), "kept\n");
		mkdirSync(join(there, "log.jsonl"));

		expect(() =>
			moveFile(join(here, "log.jsonl"), join(there, "log.jsonl")),
		).toThrow(/EISDIR/);

		expect(renames, "no copy is renamed in").toHaveLength(1);
		expect(readdirSync(there)).toEqual(["log.jsonl"]);
		expect(readFileSync(join(here, "log.jsonl"), "utf8")).toBe("kept\n");
	});
});
