import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kernelText } from "../../../../lib/internal/priority/kernel-file.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kernel-file-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("reading a kernel file", () => {
	it("reads a file larger than its first buffer whole", async () => {
		const path = join(dir, "stat");
		const text = "anon 4096\n".repeat(500);
		writeFileSync(path, text);
		expect(
			await kernelText(path, 16),
			"a file that fills the buffer is read on until its end",
		).toBe(text);
	});

	it("reads a file that fits its first buffer as it is", async () => {
		const path = join(dir, "comm");
		writeFileSync(path, "qemu-system-x86\n");
		expect(await kernelText(path), "a process's name, whole").toBe(
			"qemu-system-x86\n",
		);
		writeFileSync(path, "");
		expect(await kernelText(path), "an empty file reads as empty").toBe("");
	});

	it("rejects a file that isn't there, as open does", async () => {
		await expect(
			kernelText(join(dir, "gone")),
			"a process gone since it was listed is the caller's to treat",
		).rejects.toThrow(/ENOENT/);
	});
});

describe.skipIf(process.platform !== "linux")("on /proc", () => {
	it("reads a file the kernel says is empty whole", async () => {
		// Its figures move between two reads, so its fields are compared.
		const fields = (text: string) =>
			text.split("\n").map((line) => line.split(":", 1)[0]);
		const text = await kernelText("/proc/self/status");
		expect(text, "the file's first field").toMatch(/^Name:\t/);
		expect(fields(text), "every field a whole read gives").toEqual(
			fields(await readFile("/proc/self/status", "utf8")),
		);
	});
});
