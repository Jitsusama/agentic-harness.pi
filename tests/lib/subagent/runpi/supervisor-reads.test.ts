/**
 * What the supervisor reads back of what a reviewer wrote beside its
 * stream. Each read tells "it wrote nothing" from "it wrote something
 * we can't read", since only the first is an empty answer.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverSessionPath,
	readJournal,
	verifiedEnvelope,
} from "../../../../lib/subagent/runpi/supervisor-reads.mjs";

let dir: string;
let warned: string[];
const warn = (message: string) => warned.push(message);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "supervisor-reads-"));
	warned = [];
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("the journal a reviewer kept", () => {
	it("is read line by line, a cut-off last line costing only itself", async () => {
		const path = join(dir, "journal.jsonl");
		writeFileSync(path, '{"subject":"kept"}\n{"subject":"cut');

		expect(await readJournal(path, warn)).toEqual([{ subject: "kept" }]);
		expect(warned, "the dropped line is warned of").toHaveLength(1);
	});

	it("is empty, quietly, when the reviewer wrote none", async () => {
		expect(await readJournal(join(dir, "none.jsonl"), warn)).toEqual([]);
		expect(await readJournal(undefined, warn)).toEqual([]);
		expect(warned).toEqual([]);
	});

	it("says where it still is when it can't be read", async () => {
		const path = join(dir, "a-folder");
		mkdirSync(path);

		expect(await readJournal(path, warn)).toEqual([]);
		expect(warned).toEqual([
			expect.stringContaining(`(EISDIR); anything it recorded is still at ${path}`),
		]);
	});
});

describe("the envelope verify_output wrote", () => {
	it("is the verification when it says ok, its output with it", async () => {
		const path = join(dir, "verified.json");
		writeFileSync(
			path,
			JSON.stringify({
				ok: true,
				stage: "council",
				count: 1,
				warnings: ["w", 3],
				output: { findings: [] },
			}),
		);

		expect(await verifiedEnvelope(path, warn)).toEqual({
			called: true,
			ok: true,
			outOfBand: true,
			stage: "council",
			count: 1,
			warnings: ["w"],
			output: { findings: [] },
		});
	});

	it("is nothing when missing or not ok, and warned of when not JSON", async () => {
		const path = join(dir, "verified.json");
		expect(await verifiedEnvelope(path, warn)).toBeUndefined();
		writeFileSync(path, JSON.stringify({ ok: false }));
		expect(await verifiedEnvelope(path, warn)).toBeUndefined();
		expect(warned).toEqual([]);
		writeFileSync(path, "{not json");
		expect(await verifiedEnvelope(path, warn)).toBeUndefined();
		expect(warned).toEqual([
			"Verify-output envelope was not valid JSON; ignored",
		]);
	});
});

describe("the session pi minted", () => {
	it("is the session file written last, whatever its name", async () => {
		writeFileSync(join(dir, "1_resumed.jsonl"), "");
		writeFileSync(join(dir, "2_first.jsonl"), "");
		writeFileSync(join(dir, "notes.txt"), "");
		utimesSync(join(dir, "2_first.jsonl"), 1, 1);

		expect(
			await discoverSessionPath(dir),
			"the newest by time, though its name sorts first",
		).toBe(`${dir}/1_resumed.jsonl`);
	});

	it("is nothing when pi wrote none, or there is no folder", async () => {
		expect(await discoverSessionPath(dir)).toBeUndefined();
		expect(await discoverSessionPath(join(dir, "missing"))).toBeUndefined();
		expect(await discoverSessionPath(undefined)).toBeUndefined();
	});
});
