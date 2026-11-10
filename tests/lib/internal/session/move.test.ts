/**
 * Move notes: what a session that ended to move leaves for whoever
 * takes it up, and what holds a session from ending.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { whatHolds } from "../../../../lib/internal/session/free.ts";
import {
	type MoveNote,
	moveNoteFrom,
	readMoveNote,
	readMoveNotes,
	removeMoveNote,
	writeMoveNote,
} from "../../../../lib/internal/session/move.ts";

let folder: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "moves-"));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const note = (over: Partial<MoveNote> = {}): MoveNote => ({
	session: "01a1c1e7-1c52-7d34-91e9-6d01d8a47c3e",
	sessionFile: "/home/j/.pi/agent/sessions/x/a.jsonl",
	cwd: "/home/j/src/agentic-harness.pi",
	to: "background",
	at: "2026-11-10T09:00:00.000Z",
	addresses: ["2QZBX9", "QJ7Q1E"],
	quest: "QEST-20261109-2QZBX9",
	pid: 4100,
	...over,
});

describe("move notes", () => {
	it("keeps a note until it is taken up, and lists every one oldest first", () => {
		const later = note({
			session: "01a1c1e7-0000-7d34-91e9-6d01d8a47c3e",
			at: "2026-11-10T09:05:00.000Z",
			to: "pi",
			from: "work-attended",
		});
		writeMoveNote(later, folder);
		writeMoveNote(note(), folder);
		expect(readMoveNote(note().session, folder)).toEqual(note());
		expect(readMoveNotes(folder)).toEqual([note(), later]);

		removeMoveNote(note().session, folder);
		expect(readMoveNote(note().session, folder)).toBeUndefined();
		expect(readMoveNotes(folder)).toEqual([later]);
	});

	it("lists none where nothing has moved", () => {
		expect(readMoveNotes(join(folder, "never"))).toEqual([]);
	});

	it("reads no note that names no file, nowhere to go, or isn't one", () => {
		expect(moveNoteFrom({ ...note(), sessionFile: "a.jsonl" })).toBeUndefined();
		expect(moveNoteFrom({ ...note(), to: "penelope" })).toBeUndefined();
		expect(moveNoteFrom({ ...note(), addresses: [7] })).toBeUndefined();
		expect(moveNoteFrom("note")).toBeUndefined();
		writeFileSync(join(folder, "half.json"), "{");
		expect(readMoveNotes(folder)).toEqual([]);
	});

	it("keeps only the names a note says", () => {
		const { quest: _quest, ...plain } = note();
		expect(moveNoteFrom({ ...plain, title: "", from: 3 })).toEqual(plain);
	});
});

describe("what holds a session from ending", () => {
	const free = {
		agentIdle: true,
		pendingMessages: false,
		jobs: 0,
		prompting: false,
		typed: false,
	};

	it("is nothing once nothing of its own is out", () => {
		expect(whatHolds(free)).toBeUndefined();
	});

	it("names the first thing ending it would lose", () => {
		expect(whatHolds({ ...free, agentIdle: false, jobs: 2 })).toBe(
			"a run is under way",
		);
		expect(whatHolds({ ...free, pendingMessages: true })).toBe(
			"messages wait for it",
		);
		expect(whatHolds({ ...free, jobs: 1 })).toBe("background jobs are out");
		expect(whatHolds({ ...free, prompting: true })).toBe("a prompt is open");
		expect(whatHolds({ ...free, typed: true })).toBe(
			"text is typed and unsent",
		);
	});
});
