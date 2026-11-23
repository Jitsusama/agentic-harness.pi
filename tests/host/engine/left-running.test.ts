/**
 * What parks kept running: a note is spared by every later reap for a
 * day, beside what is carried, and goes after; a second host reading
 * the same folder spares it too; a close ends what its conversation's
 * parks kept; an unreadable file keeps nothing; and one that fails to
 * read for the moment loses no note and spares no less.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRAY_FOR_MS } from "../../../host/engine/carried-shells.ts";
import { LEFT_FILE, leftRunning } from "../../../host/engine/left-running.ts";

const NONE = { marks: new Set<string>(), groups: new Set<number>() };

/** A read of the notes to fail with this code, as the machine might. */
const readFault = vi.hoisted(() => ({ code: undefined as string | undefined }));

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	const readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
		const code = readFault.code;
		// LEFT_FILE's value: an import is not yet bound where a mock is made.
		if (code !== undefined && String(args[0]).endsWith("left-running.json"))
			throw Object.assign(new Error(`${code}: as the test asked`), { code });
		return fs.readFileSync(...args);
	}) as typeof fs.readFileSync;
	return { ...fs, readFileSync };
});

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
	readFault.code = undefined;
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

	it("keeps saying a carried record wouldn't read, beside what a park noted", () => {
		kept().note("a", ["call-1"]);
		const carried = { marks: new Set<string>(), groups: new Set<number>() };
		expect(
			kept().spared({ ...carried, unread: true }).unread,
			"the reap still knows whom to spare is unknown",
		).toBe(true);
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

	it("spares a note no longer once its day is out", () => {
		const left = kept();
		left.note("a", ["expires"]);
		at += STRAY_FOR_MS / 2;
		left.note("b", ["newer"]);
		at += STRAY_FOR_MS / 2;
		expect(
			[...left.spared(NONE).marks],
			"the note not made again went after its day",
		).toEqual(["newer"]);
	});

	it("spares no longer what a closed conversation's parks kept, keeping every other's", () => {
		kept().note("a", ["call-1", "call-2"]);
		kept().note("b", ["call-3"]);
		expect(kept().closed("a"), "both its calls' notes went").toBe(2);
		expect([...kept().spared(NONE).marks]).toEqual(["call-3"]);
		expect(kept().closed("b")).toBe(1);
		expect(kept().spared(NONE)).toBe(NONE);
		kept().note("c", ["call-4"]);
		expect(kept().closed("never-parked"), "it kept nothing").toBe(0);
		expect([...kept().spared(NONE).marks], "nor did another's go").toEqual([
			"call-4",
		]);
		expect(reported).toEqual([]);
	});

	it("spares only what is carried when nothing was noted or the file is unreadable", () => {
		expect(kept().spared(NONE)).toBe(NONE);
		writeFileSync(join(stateDir, LEFT_FILE), "not json");
		expect(kept().spared(NONE)).toBe(NONE);
		kept().note("a", []);
		expect(kept().spared(NONE)).toBe(NONE);
	});

	it("waits, rather than spare less, while its notes fail to read for the moment", () => {
		kept().note("a", ["call-1"]);
		readFault.code = "EMFILE";
		expect(kept().spared(NONE).unread, "whom to spare is not known").toBe(true);
	});

	it("loses no earlier note to a read that fails for the moment", () => {
		kept().note("a", ["call-1"]);
		readFault.code = "EMFILE";
		kept().note("b", ["call-2"]);
		expect(kept().closed("c"), "nothing is said closed").toBe(0);
		readFault.code = undefined;
		expect([...kept().spared(NONE).marks], "the earlier note stays").toContain(
			"call-1",
		);
		expect(reported.length, "the note that could not go in is said").toBe(1);
	});
});
