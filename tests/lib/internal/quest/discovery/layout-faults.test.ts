import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type KeepLayoutFaultsOptions,
	keepLayoutFaults,
	type LayoutFaultsRecord,
	readLayoutFaults,
} from "../../../../../lib/internal/quest/discovery/layout-faults.ts";

let dir: string;
let file: string;
let journalled: string[][];
let clock: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "layout-faults-"));
	file = join(dir, "state", "layout-faults.json");
	journalled = [];
	clock = "2026-11-20T15:00:00.000Z";
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const ROOT = "/q";
const noReadme = { path: "/q/QEST-1", message: "README.md missing" };
const nested = { path: "/q/QEST-2/QEST-3", message: "nested quest" };

/** The options every keep here is given: this test's file, clock and journal. */
function options(): KeepLayoutFaultsOptions {
	return {
		file,
		now: () => new Date(clock),
		journal: (lines) => journalled.push([...lines]),
	};
}

/** The record as read back, or undefined when it isn't one. */
function record(): LayoutFaultsRecord | undefined {
	const reading = readLayoutFaults(file);
	return reading.kind === "read" ? reading.record : undefined;
}

describe("keepLayoutFaults", () => {
	it("records what a walk found, keeping when each fault was first seen", async () => {
		await keepLayoutFaults(ROOT, [noReadme], options());
		clock = "2026-11-20T16:00:00.000Z";
		const fresh = await keepLayoutFaults(ROOT, [noReadme, nested], options());

		expect(fresh, "the second start's new faults").toEqual([nested]);
		expect(record(), "the record").toEqual({
			root: ROOT,
			checkedAt: "2026-11-20T16:00:00.000Z",
			faults: [
				{ ...noReadme, since: "2026-11-20T15:00:00.000Z" },
				{ ...nested, since: "2026-11-20T16:00:00.000Z" },
			],
		});
	});

	it("journals a fault only when the record didn't hold it", async () => {
		await keepLayoutFaults(ROOT, [noReadme], options());
		await keepLayoutFaults(ROOT, [noReadme], options());

		expect(journalled, "what the journal was told").toEqual([
			[
				'quest-workflow: a quest layout fault at "/q/QEST-1": "README.md missing"',
			],
		]);
	});

	it("journals a start's new faults in one write", async () => {
		await keepLayoutFaults(ROOT, [noReadme, nested], options());

		expect(journalled, "the writes the journal was given").toEqual([
			[
				expect.stringContaining("QEST-1"),
				expect.stringContaining("QEST-2/QEST-3"),
			],
		]);
	});

	it("keeps a folder's name from breaking its journal line in two", async () => {
		const forged = {
			path: "/q/QEST-4\n<0>forged",
			message: "README.md missing",
		};

		await keepLayoutFaults(ROOT, [forged], options());

		expect(
			journalled.flat().join("\n").split("\n"),
			"the journal's lines",
		).toEqual([
			'quest-workflow: a quest layout fault at "/q/QEST-4\\n<0>forged": "README.md missing"',
		]);
	});

	it("drops a fault since fixed, and counts it new when it comes back", async () => {
		await keepLayoutFaults(ROOT, [noReadme, nested], options());
		await keepLayoutFaults(ROOT, [nested], options());

		expect(
			record()?.faults.map((fault) => fault.path),
			"the faults that still hold",
		).toEqual([nested.path]);

		clock = "2026-11-20T17:00:00.000Z";
		const fresh = await keepLayoutFaults(ROOT, [noReadme, nested], options());

		expect(fresh, "the fault that came back").toEqual([noReadme]);
		expect(
			record()?.faults[0]?.since,
			"when the fault that came back was seen again",
		).toBe("2026-11-20T17:00:00.000Z");
	});

	it("keeps one of a fault a walk reports twice", async () => {
		const fresh = await keepLayoutFaults(ROOT, [noReadme, noReadme], options());

		expect(fresh, "the new faults").toEqual([noReadme]);
		expect(record()?.faults, "the record's faults").toHaveLength(1);
	});

	it("leaves a record a later walk wrote as it is", async () => {
		clock = "2026-11-20T16:00:00.000Z";
		await keepLayoutFaults(ROOT, [nested], options());
		clock = "2026-11-20T15:59:59.000Z";

		const fresh = await keepLayoutFaults(ROOT, [noReadme], options());

		expect(fresh, "the older walk's new faults").toEqual([]);
		expect(record(), "the later walk's record").toEqual({
			root: ROOT,
			checkedAt: "2026-11-20T16:00:00.000Z",
			faults: [{ ...nested, since: "2026-11-20T16:00:00.000Z" }],
		});
	});

	it("counts every fault new over a record of another quests root", async () => {
		await keepLayoutFaults("/elsewhere", [noReadme], options());

		const fresh = await keepLayoutFaults(ROOT, [noReadme], options());

		expect(fresh, "the faults counted new").toEqual([noReadme]);
		expect(record()?.root, "the root the record now describes").toBe(ROOT);
	});

	it("empties the record when every fault is fixed", async () => {
		await keepLayoutFaults(ROOT, [noReadme], options());
		await keepLayoutFaults(ROOT, [], options());

		expect(record()?.faults, "the faults left").toEqual([]);
	});

	it("writes nothing, and makes no record, when a tidy tree has none", async () => {
		const fresh = await keepLayoutFaults(ROOT, [], options());

		expect(fresh, "the new faults").toEqual([]);
		expect(existsSync(file), "whether a record was made").toBe(false);
		expect(readLayoutFaults(file), "the reading").toEqual({ kind: "none" });
	});

	it("keeps a fault the same path names with another message", async () => {
		await keepLayoutFaults(ROOT, [noReadme], options());
		const other = { path: noReadme.path, message: "front matter unreadable" };

		const fresh = await keepLayoutFaults(ROOT, [noReadme, other], options());

		expect(fresh, "a new message about a known path").toEqual([other]);
	});

	it("says a record it can't read is unreadable, and starts it afresh", async () => {
		mkdirSync(join(dir, "state"));
		writeFileSync(file, '{"checkedAt":"2026-11-20T14:00');

		expect(readLayoutFaults(file).kind, "the torn record's reading").toBe(
			"unreadable",
		);

		const fresh = await keepLayoutFaults(ROOT, [noReadme], options());

		expect(fresh, "the faults counted new").toEqual([noReadme]);
		expect(record()?.faults, "the record").toHaveLength(1);
	});

	it("writes an unreadable record afresh even when a walk finds nothing", async () => {
		mkdirSync(join(dir, "state"));
		writeFileSync(file, "not json");

		await keepLayoutFaults(ROOT, [], options());

		expect(record(), "the record written afresh").toEqual({
			root: ROOT,
			checkedAt: clock,
			faults: [],
		});
	});

	it("journals a record it can't write with the faults it would hold, and answers", async () => {
		writeFileSync(join(dir, "state"), "a file where the folder goes");

		const fresh = await keepLayoutFaults(ROOT, [noReadme], options());

		expect(fresh, "the faults it could keep").toEqual([]);
		expect(journalled, "what the journal was told").toEqual([
			[
				expect.stringContaining("couldn't be written"),
				expect.stringContaining("QEST-1"),
			],
		]);
	});

	it("answers when the journal itself throws", async () => {
		const throwing = {
			...options(),
			journal: () => {
				throw new Error("no journal");
			},
		};

		await expect(
			keepLayoutFaults(ROOT, [noReadme], throwing),
			"a keep whose journal throws",
		).resolves.toEqual([noReadme]);
	});
});
