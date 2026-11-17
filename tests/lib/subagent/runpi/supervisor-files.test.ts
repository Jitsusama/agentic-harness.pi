/**
 * How the supervisor writes its files: logs rotated into gzipped
 * copies past their cap, and records replaced whole so a reader never
 * sees half of one.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendRotating,
	exists,
	writeJsonAtomic,
} from "../../../../lib/subagent/runpi/supervisor-files.mjs";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "supervisor-files-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("a stream log", () => {
	it("rotates into gzipped copies past its cap, keeping as many as it may", async () => {
		const path = join(dir, "logs", "events.jsonl");
		const limits = { maxBytes: 4, maxRotations: 2 };
		for (const chunk of ["aaa", "bbb", "ccc", "ddd"])
			await appendRotating(path, Buffer.from(chunk), limits);

		expect(readFileSync(path, "utf8")).toBe("ddd");
		expect(gunzipSync(readFileSync(`${path}.1.gz`)).toString()).toBe("ccc");
		expect(gunzipSync(readFileSync(`${path}.2.gz`)).toString()).toBe("bbb");
		expect(
			readdirSync(join(dir, "logs")).sort(),
			"the oldest went, and nothing was left mid-rotation",
		).toEqual(["events.jsonl", "events.jsonl.1.gz", "events.jsonl.2.gz"]);
	});

	it("grows within its cap", async () => {
		const path = join(dir, "stderr.log");
		const limits = { maxBytes: 10, maxRotations: 3 };
		await appendRotating(path, Buffer.from("ab"), limits);
		await appendRotating(path, Buffer.from("cd"), limits);

		expect(readFileSync(path, "utf8")).toBe("abcd");
		expect(await exists(`${path}.1.gz`)).toBe(false);
	});
});

describe("a record", () => {
	it("is replaced whole as tab-indented JSON, leaving no temporary file", async () => {
		const path = join(dir, "run", "lease.json");
		await writeJsonAtomic(path, { state: "starting" });
		await writeJsonAtomic(path, { state: "running" });

		expect(readFileSync(path, "utf8")).toBe('{\n\t"state": "running"\n}\n');
		expect(readdirSync(join(dir, "run"))).toEqual(["lease.json"]);
	});

	it("is there once written, a folder too", async () => {
		mkdirSync(join(dir, "folder"));
		expect(await exists(join(dir, "folder"))).toBe(true);
		expect(await exists(join(dir, "missing"))).toBe(false);
	});
});
