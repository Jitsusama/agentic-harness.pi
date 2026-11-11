/**
 * Move notes: what a session that ended to move leaves for whoever
 * takes it up, and what holds a session from ending.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { whatHolds } from "../../../../lib/internal/session/free.ts";
import {
	claimMoveNote,
	giveBackMoveNote,
	type MoveNote,
	moveNoteFrom,
	noteState,
	readMoveNote,
	readMoveNotes,
	removeMoveNote,
	restoreStrandedClaims,
	takeBackMove,
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

	it("keeps how the session ran its commands, and nothing else in its place", () => {
		const fenced = { ...note(), env: { PI_SANDBOX: "fence" } };
		expect(
			moveNoteFrom(fenced),
			"a fenced session's note says the fence",
		).toEqual(fenced);
		expect(
			moveNoteFrom({ ...note(), env: { PI_SANDBOX: "fence", HOME: "/x" } }),
			"a note's env holding anything but the carried variables is dropped",
		).toEqual(note());
	});
});

describe("claiming a move note", () => {
	const session = note().session;
	const CUTOVER = 7001;
	const JOIN = 7002;
	// Every file a note or a claim left, past writeWhole's own `.writing`.
	const left = () =>
		readdirSync(folder).filter((name) => !name.startsWith("."));

	it("tells a waiting note from a claimed one and from none", () => {
		expect(noteState(session, folder), "never left").toBe("none");
		writeMoveNote(note(), folder);
		expect(noteState(session, folder)).toBe("waiting");
		claimMoveNote(session, CUTOVER, folder);
		expect(noteState(session, folder)).toBe("claimed");
		removeMoveNote(session, folder);
		expect(noteState(session, folder), "taken up").toBe("none");
		expect(noteState(session, join(folder, "gone")), "no folder").toBe("none");
	});

	it("lets the cutover adopt, and then tells the join it is adopting", () => {
		writeMoveNote(note(), folder);
		expect(claimMoveNote(session, CUTOVER, folder)).toEqual(note());
		expect(readMoveNotes(folder), "a claimed note hidden from readers").toEqual(
			[],
		);
		expect(takeBackMove(session, JOIN, folder)).toBe("adopting");
		removeMoveNote(session, folder);
		expect(left(), "nothing left once adopted").toEqual([]);
		expect(takeBackMove(session, JOIN, folder)).toBe("adopting");
	});

	it("lets the join take it first, leaving the cutover nothing to adopt", () => {
		writeMoveNote(note(), folder);
		expect(takeBackMove(session, JOIN, folder)).toBe("taken");
		expect(claimMoveNote(session, CUTOVER, folder)).toBeUndefined();
		expect(left()).toEqual([]);
	});

	it("lets the join take back a note the cutover gave back", () => {
		writeMoveNote(note(), folder);
		claimMoveNote(session, CUTOVER, folder);
		giveBackMoveNote(session, CUTOVER, folder);
		expect(readMoveNote(session, folder)).toEqual(note());
		expect(takeBackMove(session, JOIN, folder)).toBe("taken");
	});

	it("gives back a claim whose cutover died, and drops one a newer note replaced", () => {
		const other = note({ session: "01a1c1e7-0000-7d34-91e9-6d01d8a47c3e" });
		writeMoveNote(note(), folder);
		writeMoveNote(other, folder);
		claimMoveNote(session, CUTOVER, folder);
		claimMoveNote(other.session, CUTOVER, folder);
		writeMoveNote({ ...other, at: "2026-11-10T10:00:00.000Z" }, folder);

		restoreStrandedClaims(() => true, folder);
		expect(readMoveNotes(folder), "a live cutover's claims kept").toHaveLength(
			1,
		);

		restoreStrandedClaims((pid) => pid !== CUTOVER, folder);
		expect(readMoveNotes(folder)).toEqual([
			note(),
			{ ...other, at: "2026-11-10T10:00:00.000Z" },
		]);
		expect(left()).toHaveLength(2);
	});

	it("claims nothing where nothing has moved", () => {
		const nowhere = join(folder, "never");
		expect(claimMoveNote(session, CUTOVER, nowhere)).toBeUndefined();
		expect(takeBackMove(session, JOIN, nowhere)).toBe("adopting");
		restoreStrandedClaims(() => false, nowhere);
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
