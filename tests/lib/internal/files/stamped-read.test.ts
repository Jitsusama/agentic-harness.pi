import {
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readStamped,
	readStampedOff,
	type Stamped,
} from "../../../../lib/internal/files/stamped-read.ts";

describe("a stamped read", () => {
	let dir: string;
	let path: string;
	let parses: number;
	let kept: Map<string, Stamped<string>>;
	// A blank file stands for a torn one, which reads as nothing.
	const parse = (text: string) => {
		parses += 1;
		return text.trim() === "" ? undefined : text.trim();
	};
	const read = (at: string) => parse(readFileSync(at, "utf8"));
	const readOff = async (at: string) => parse(await readFile(at, "utf8"));

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "stamped-"));
		path = join(dir, "one.json");
		parses = 0;
		kept = new Map();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("parses a file once while it stays the file it was", () => {
		writeFileSync(path, "first");

		expect(readStamped(kept, path, read)).toBe("first");
		expect(readStamped(kept, path, read)).toBe("first");
		expect(parses).toBe(1);
	});

	it("parses again once a new file is renamed in", () => {
		writeFileSync(path, "first");
		readStamped(kept, path, read);
		writeFileSync(join(dir, "next.tmp"), "second");
		renameSync(join(dir, "next.tmp"), path);

		expect(readStamped(kept, path, read)).toBe("second");
		expect(parses).toBe(2);
	});

	it("keeps what an unreadable file read as, until it changes", () => {
		writeFileSync(path, " ");

		expect(readStamped(kept, path, read)).toBeUndefined();
		expect(readStamped(kept, path, read)).toBeUndefined();
		expect(parses).toBe(1);
	});

	it("forgets a file gone since it was read", () => {
		writeFileSync(path, "first");
		readStamped(kept, path, read);
		rmSync(path);

		expect(readStamped(kept, path, () => "never read")).toBeUndefined();
		expect([...kept.keys()]).toEqual([]);
	});

	it("reads off the thread as it reads on it, sharing what each kept", async () => {
		writeFileSync(path, "first");
		let turned = false;
		setImmediate(() => {
			turned = true;
		});

		const off = await readStampedOff(kept, path, readOff);

		expect(turned, "the thread turned while the file was read").toBe(true);
		expect(off).toBe("first");
		expect(readStamped(kept, path, read)).toBe("first");
		expect(parses).toBe(1);
		rmSync(path);
		expect(
			await readStampedOff(kept, path, async () => "never read"),
		).toBeUndefined();
		expect([...kept.keys()]).toEqual([]);
	});
});
