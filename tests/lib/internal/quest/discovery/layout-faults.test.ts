import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keepLayoutFaults } from "../../../../../lib/internal/quest/discovery/layout-faults.ts";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "layout-faults-"));
	file = join(dir, "state", "layout-faults.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const noReadme = { path: "/q/QEST-1", message: "README.md missing" };
const nested = { path: "/q/QEST-2/QEST-3", message: "nested quest" };
const at = () => new Date("2026-11-20T15:00:00.000Z");

/** The record's lines, each read back as JSON. */
function recorded(): unknown[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

describe("keepLayoutFaults", () => {
	it("writes each fault once, however many starts find it", async () => {
		const first = await keepLayoutFaults([noReadme], file, at);
		const second = await keepLayoutFaults([noReadme, nested], file, at);

		expect(first, "the first start's new faults").toBe(1);
		expect(second, "the second start's new faults").toBe(1);
		expect(recorded(), "one line a fault").toEqual([
			{ at: "2026-11-20T15:00:00.000Z", ...noReadme },
			{ at: "2026-11-20T15:00:00.000Z", ...nested },
		]);
	});

	it("writes a fault once when two starts find it at the same time", async () => {
		const added = await Promise.all([
			keepLayoutFaults([noReadme], file, at),
			keepLayoutFaults([noReadme], file, at),
		]);

		expect(
			added.reduce((sum, n) => sum + n, 0),
			"the faults both added",
		).toBe(1);
		expect(recorded(), "the record").toHaveLength(1);
	});

	it("reads past a line cut short and keeps what it names", async () => {
		await keepLayoutFaults([noReadme], file, at);
		appendFileSync(file, '{"at":"2026-11-20T15:01:00.000Z","pa\n');

		const added = await keepLayoutFaults([noReadme], file, at);

		expect(added, "a fault already recorded before the cut line").toBe(0);
	});

	it("writes nothing, and makes no record, when a start finds no fault", async () => {
		const added = await keepLayoutFaults([], file, at);

		expect(added, "the faults added").toBe(0);
		expect(() => readFileSync(file), "the record").toThrow();
	});

	it("keeps a fault the same path names with another message", async () => {
		await keepLayoutFaults([noReadme], file, at);

		const added = await keepLayoutFaults(
			[{ path: noReadme.path, message: "front matter unreadable" }],
			file,
			at,
		);

		expect(added, "a new message about a known path").toBe(1);
	});
});
