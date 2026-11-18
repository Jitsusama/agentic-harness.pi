import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processGlobal } from "../../../lib/internal/process/process-global.ts";

/** What statfs says a folder's filesystem is, by its magic number. */
const BTRFS = 0x9123683e;
const EXT4 = 0xef53;

/** Where write-whole keeps what it learned of each device. */
const DEVICES = "agentic-harness.write-whole.renames-keep-data";

const disk = vi.hoisted(() => ({
	type: 0 as number | Error,
	syncs: 0,
	asked: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		fsyncSync: (fd: number) => {
			disk.syncs += 1;
			actual.fsyncSync(fd);
		},
		statfsSync: (path: fs.PathLike) => {
			disk.asked.push(String(path));
			if (disk.type instanceof Error) throw disk.type;
			return { ...actual.statfsSync(path), type: disk.type };
		},
	};
});

const { writeWhole } = await import("../../../lib/internal/write-whole.ts");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(join(tmpdir(), "write-whole-durable-"));
	disk.syncs = 0;
	disk.asked = [];
	disk.type = BTRFS;
	processGlobal(DEVICES, () => new Map<number, boolean>()).clear();
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("writing a file whole durably", () => {
	it("replaces one on btrfs without a flush, since its rename keeps the old or the new", () => {
		const file = join(dir, "README.md");
		fs.writeFileSync(file, "old");

		writeWhole(file, "new", { durable: true });

		expect(fs.readFileSync(file, "utf8")).toBe("new");
		expect(disk.syncs).toBe(0);
		expect(disk.asked).toEqual([dir]);
	});

	it("asks each device's filesystem once", () => {
		const file = join(dir, "README.md");
		fs.writeFileSync(file, "old");

		writeWhole(file, "new", { durable: true });
		writeWhole(file, "newer", { durable: true });

		expect(disk.asked).toEqual([dir]);
		expect(disk.syncs).toBe(0);
	});

	it("flushes a new one on btrfs, which no file stands behind", () => {
		const file = join(dir, "README.md");

		writeWhole(file, "new", { durable: true });

		expect(fs.readFileSync(file, "utf8")).toBe("new");
		expect(disk.syncs).toBe(1);
	});

	it("flushes one whose name holds a link rather than a file", () => {
		fs.writeFileSync(join(dir, "elsewhere"), "old");
		const file = join(dir, "README.md");
		fs.symlinkSync(join(dir, "elsewhere"), file);

		writeWhole(file, "new", { durable: true });

		expect(fs.readFileSync(file, "utf8")).toBe("new");
		expect(disk.syncs).toBe(1);
	});

	it("flushes a replacement on another filesystem, whose rename may land first", () => {
		disk.type = EXT4;
		const file = join(dir, "README.md");
		fs.writeFileSync(file, "old");

		writeWhole(file, "new", { durable: true });

		expect(disk.syncs).toBe(1);
	});

	it("flushes a replacement when the filesystem can't be told, and asks again next time", () => {
		disk.type = new Error("EIO: i/o error, statfs");
		const file = join(dir, "README.md");
		fs.writeFileSync(file, "old");

		writeWhole(file, "new", { durable: true });
		disk.type = BTRFS;
		writeWhole(file, "newer", { durable: true });

		expect(fs.readFileSync(file, "utf8")).toBe("newer");
		expect(disk.syncs).toBe(1);
		expect(disk.asked).toEqual([dir, dir]);
	});

	it("never flushes a write that isn't asked to be durable", () => {
		disk.type = EXT4;

		writeWhole(join(dir, "queue.json"), "new");

		expect(disk.syncs).toBe(0);
	});
});
