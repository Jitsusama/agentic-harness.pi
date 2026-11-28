/**
 * Which run folders a session's own: each ledger record is read once a
 * process, since the sandbox asks at every strict command and file
 * tool's read, and reading optimus's 1,970 records each time took
 * 229 ms. What reached the session is read again at each ask, so a
 * record the sweep removed and another session wrote again under the
 * same name never reaches it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Each file read, by path. */
const disk = vi.hoisted(() => ({ read: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
		disk.read.push(String(args[0]));
		return real.readFileSync(...args);
	}) as typeof real.readFileSync;
	const mocked = { ...real, readFileSync };
	return { ...mocked, default: mocked };
});

// Imported afresh, so the module reads through the counting stand-in.
vi.resetModules();
const { anotherSessionsRun, ownFleetRuns } = await import(
	"../../../lib/subagent/fleet-reach.ts"
);

let state: string;

beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "fleet-reach-"));
	mkdirSync(join(state, "fleets"));
	disk.read.length = 0;
});

afterEach(() => {
	rmSync(state, { recursive: true, force: true });
});

/** Write the ledger's record of a fleet `session` ran under `id`. */
function record(id: string, session: string): string {
	const path = join(state, "fleets", `${id}.json`);
	writeFileSync(path, JSON.stringify({ id, session }));
	return path;
}

/** The run folder a fleet named `id` keeps its reports in. */
function runOf(id: string): string {
	return join(state, "runs", id);
}

describe("a session's own run folders", () => {
	it("reach its own fleets and nobody else's", () => {
		record("mine", "a");
		record("theirs", "b");

		expect(ownFleetRuns("a", state)).toEqual([runOf("mine")]);
	});

	it("read another session's record once, however often it's asked", () => {
		const theirs = record("theirs", "b");
		record("mine", "a");

		ownFleetRuns("a", state);
		ownFleetRuns("a", state);
		ownFleetRuns("a", state);

		expect(disk.read.filter((path) => path === theirs)).toHaveLength(1);
	});

	it("reach a fleet the ledger gained since the last ask", () => {
		record("first", "a");
		expect(ownFleetRuns("a", state)).toEqual([runOf("first")]);

		record("second", "a");

		expect(ownFleetRuns("a", state).sort()).toEqual(
			[runOf("first"), runOf("second")].sort(),
		);
	});

	it("read a record again that was half written when first asked", () => {
		const path = join(state, "fleets", "late.json");
		writeFileSync(path, '{"id": "late", "sess');
		expect(ownFleetRuns("a", state)).toEqual([]);

		record("late", "a");

		expect(ownFleetRuns("a", state)).toEqual([runOf("late")]);
	});

	it("never reach a name the sweep removed and another session wrote again", () => {
		const path = record("reused", "a");
		expect(ownFleetRuns("a", state)).toEqual([runOf("reused")]);

		rmSync(path);
		record("reused", "b");

		expect(ownFleetRuns("a", state)).toEqual([]);
	});

	it("reach a name this session takes over once the sweep removed another's", () => {
		const path = record("reused", "b");
		expect(ownFleetRuns("a", state)).toEqual([]);

		rmSync(path);
		expect(anotherSessionsRun("reused", "a", state)).toBe(false);
		record("reused", "a");

		expect(ownFleetRuns("a", state)).toEqual([runOf("reused")]);
	});
});
