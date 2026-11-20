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
	readLayoutFaults,
} from "../../../../../lib/internal/quest/discovery/layout-faults.ts";

let dir: string;
let file: string;
let journalled: string[];
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

const noReadme = { path: "/q/QEST-1", message: "README.md missing" };
const nested = { path: "/q/QEST-2/QEST-3", message: "nested quest" };

/** The options every keep here is given: this test's file, clock and journal. */
function options(): KeepLayoutFaultsOptions {
	return {
		file,
		now: () => new Date(clock),
		journal: (line) => journalled.push(line),
	};
}

describe("keepLayoutFaults", () => {
	it("records what a start found, keeping when each fault was first seen", async () => {
		await keepLayoutFaults([noReadme], options());
		clock = "2026-11-20T16:00:00.000Z";
		const fresh = await keepLayoutFaults([noReadme, nested], options());

		expect(fresh, "the second start's new faults").toEqual([nested]);
		expect(readLayoutFaults(file), "the record").toEqual({
			checkedAt: "2026-11-20T16:00:00.000Z",
			faults: [
				{ ...noReadme, since: "2026-11-20T15:00:00.000Z" },
				{ ...nested, since: "2026-11-20T16:00:00.000Z" },
			],
		});
	});

	it("journals a fault only when the record didn't hold it", async () => {
		await keepLayoutFaults([noReadme], options());
		await keepLayoutFaults([noReadme], options());

		expect(journalled, "what the journal was told").toEqual([
			"quest-workflow: /q/QEST-1 is skipped from the quest index: README.md missing",
		]);
	});

	it("drops a fault since fixed, and counts it new when it comes back", async () => {
		await keepLayoutFaults([noReadme, nested], options());
		await keepLayoutFaults([nested], options());

		expect(
			readLayoutFaults(file)?.faults.map((fault) => fault.path),
			"the faults that still hold",
		).toEqual([nested.path]);

		clock = "2026-11-20T17:00:00.000Z";
		const fresh = await keepLayoutFaults([noReadme, nested], options());

		expect(fresh, "the fault that came back").toEqual([noReadme]);
		expect(
			readLayoutFaults(file)?.faults[0]?.since,
			"when the fault that came back was seen again",
		).toBe("2026-11-20T17:00:00.000Z");
	});

	it("empties the record when every fault is fixed", async () => {
		await keepLayoutFaults([noReadme], options());
		await keepLayoutFaults([], options());

		expect(readLayoutFaults(file)?.faults, "the faults left").toEqual([]);
	});

	it("writes nothing, and makes no record, when a tidy tree has none", async () => {
		const fresh = await keepLayoutFaults([], options());

		expect(fresh, "the new faults").toEqual([]);
		expect(existsSync(file), "whether a record was made").toBe(false);
	});

	it("keeps a fault the same path names with another message", async () => {
		await keepLayoutFaults([noReadme], options());
		const other = { path: noReadme.path, message: "front matter unreadable" };

		const fresh = await keepLayoutFaults([noReadme, other], options());

		expect(fresh, "a new message about a known path").toEqual([other]);
	});

	it("starts afresh over a record it can't read", async () => {
		mkdirSync(join(dir, "state"));
		writeFileSync(file, '{"checkedAt":"2026-11-20T14:00');

		const fresh = await keepLayoutFaults([noReadme], options());

		expect(fresh, "the faults counted new").toEqual([noReadme]);
		expect(readLayoutFaults(file)?.faults, "the record").toHaveLength(1);
	});

	it("journals a record it can't write, and answers rather than rejecting", async () => {
		writeFileSync(join(dir, "state"), "a file where the folder goes");

		const fresh = await keepLayoutFaults([noReadme], options());

		expect(fresh, "the faults it could keep").toEqual([]);
		expect(journalled, "what the journal was told").toEqual([
			expect.stringContaining("couldn't be written"),
		]);
	});
});
