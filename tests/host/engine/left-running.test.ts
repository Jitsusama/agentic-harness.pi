/**
 * What parks kept running: a note is spared by every later reap for a
 * day, beside what is carried, and goes after; a second host reading
 * the same folder spares it too; a close ends what its conversation's
 * parks kept; and an unreadable file keeps nothing.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STRAY_FOR_MS } from "../../../host/engine/carried-shells.ts";
import { LEFT_FILE, leftRunning } from "../../../host/engine/left-running.ts";

const NONE = { marks: new Set<string>(), groups: new Set<number>() };

let stateDir: string;
let at: number;
const reported: unknown[] = [];

function kept() {
	return leftRunning({
		stateDir,
		report: (error) => reported.push(error),
		now: () => at,
	});
}

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "left-running-"));
	at = 1_000_000;
	reported.length = 0;
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

describe("what parks kept running", () => {
	it("spares what a park noted, beside what is carried, from the next host's start too", () => {
		kept().note("a", ["call-1", "call-2"]);
		const carried = { marks: new Set(["carried"]), groups: new Set([7]) };
		const spared = kept().spared(carried);
		expect([...spared.marks].sort()).toEqual(["call-1", "call-2", "carried"]);
		expect([...spared.groups]).toEqual([7]);
		expect(reported).toEqual([]);
	});

	it("keeps each note a day after its park, a note made again counting from then", () => {
		const left = kept();
		left.note("a", ["old"]);
		at += STRAY_FOR_MS / 2;
		left.note("b", ["newer"]);
		left.note("a", ["old"]);
		at += STRAY_FOR_MS / 2;
		expect([...left.spared(NONE).marks].sort()).toEqual(["newer", "old"]);
		const notes = JSON.parse(readFileSync(join(stateDir, LEFT_FILE), "utf8"));
		expect(notes, "one note a mark, the newer").toEqual([
			{ session: "b", mark: "newer", at: at - STRAY_FOR_MS / 2 },
			{ session: "a", mark: "old", at: at - STRAY_FOR_MS / 2 },
		]);
	});

	it("spares no longer what a closed conversation's parks kept, keeping every other's", () => {
		kept().note("a", ["call-1", "call-2"]);
		kept().note("b", ["call-3"]);
		kept().closed("a");
		expect([...kept().spared(NONE).marks]).toEqual(["call-3"]);
		kept().closed("b");
		expect(kept().spared(NONE)).toBe(NONE);
		kept().closed("never-parked");
		expect(reported).toEqual([]);
	});

	it("spares only what is carried when nothing was noted or the file is unreadable", () => {
		expect(kept().spared(NONE)).toBe(NONE);
		writeFileSync(join(stateDir, LEFT_FILE), "not json");
		expect(kept().spared(NONE)).toBe(NONE);
		kept().note("a", []);
		expect(kept().spared(NONE)).toBe(NONE);
	});
});
