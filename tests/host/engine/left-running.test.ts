/**
 * What parks kept running: a note is spared by every later reap for a
 * day, beside what is carried, and goes after; a second host reading
 * the same folder spares it too; a close ends what its conversation's
 * parks kept; an unreadable file keeps nothing; and one that fails to
 * read for the moment loses no note and spares no less. A child's own
 * folder and the engine folder's are read together, whichever host runs
 * the conversation, and a start reaping the whole key spares every
 * folder's notes, or waits while one of them fails to read.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRAY_FOR_MS } from "../../../host/engine/carried-shells.ts";
import {
	LEFT_FILE,
	leftRunning,
	sparedUnder,
} from "../../../host/engine/left-running.ts";

const NONE = { marks: new Set<string>(), groups: new Set<number>() };

/** A read of the notes to fail with this code, as the machine might, only in the folder named when one is. */
const readFault = vi.hoisted(() => ({
	code: undefined as string | undefined,
	only: undefined as string | undefined,
}));

/** Whether a read of `file` is to fail as the test asked. */
const faulted = vi.hoisted(
	() => (file: unknown) =>
		readFault.code !== undefined &&
		// LEFT_FILE's value: an import is not yet bound where a mock is made.
		String(file).endsWith(
			readFault.only === undefined
				? "left-running.json"
				: `${readFault.only}/left-running.json`,
		),
);

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	const readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
		const code = readFault.code;
		if (faulted(args[0]))
			throw Object.assign(new Error(`${code}: as the test asked`), { code });
		return fs.readFileSync(...args);
	}) as typeof fs.readFileSync;
	return { ...fs, readFileSync };
});

vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const readFile = ((...args: Parameters<typeof fs.readFile>) => {
		const code = readFault.code;
		if (faulted(args[0]))
			return Promise.reject(
				Object.assign(new Error(`${code}: as the test asked`), { code }),
			);
		return fs.readFile(...args);
	}) as typeof fs.readFile;
	return { ...fs, readFile };
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

/** What a child host keeps, in its conversation's own folder under the engine folder. */
function childKept(conversation: string) {
	const own = join(stateDir, conversation);
	mkdirSync(own, { recursive: true });
	return leftRunning({
		stateDir,
		keptIn: () => own,
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
	readFault.only = undefined;
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

	it("spares, in a child, what the engine folder's host parked before the child took its conversation up", () => {
		kept().note("a", ["realm-call"]);
		childKept("a").note("a", ["child-call"]);
		expect([...childKept("a").spared(NONE).marks].sort()).toEqual([
			"child-call",
			"realm-call",
		]);
		expect(
			[...kept().spared(NONE).marks],
			"naming no conversation, the engine folder's host reads only its own",
		).toEqual(["realm-call"]);
	});

	it("spares, in the engine folder's host, what a child parked before the conversation moved back in", () => {
		childKept("a").note("a", ["child-call"]);
		childKept("b").note("b", ["other-child-call"]);
		kept().note("a", ["realm-call"]);
		expect(
			[...kept().spared(NONE, "a").marks].sort(),
			"its own folder's beside the engine folder's, and no other's",
		).toEqual(["child-call", "realm-call"]);
		expect(reported).toEqual([]);
	});

	it("drops, at the engine folder's host's close, what a child parked of that conversation", () => {
		childKept("a").note("a", ["child-call"]);
		kept().note("a", ["realm-call"]);
		kept().note("b", ["other-call"]);
		expect(kept().closed("a"), "its notes in both folders").toBe(2);
		expect([...kept().spared(NONE, "a").marks]).toEqual(["other-call"]);
		expect(reported).toEqual([]);
	});

	it("reads no folder outside the engine folder for a conversation named as a path", () => {
		mkdirSync(join(stateDir, "outside"));
		childKept("outside").note("x", ["outside-call"]);
		const inner = join(stateDir, "inner");
		mkdirSync(inner);
		const left = leftRunning({
			stateDir: inner,
			report: (error) => reported.push(error),
			now: () => at,
		});
		expect(left.spared(NONE, "../outside")).toBe(NONE);
		expect(left.closed("../outside")).toBe(0);
	});

	it("drops, at a child's close, its conversation's notes from the engine folder too, keeping another's", () => {
		kept().note("a", ["realm-call"]);
		kept().note("b", ["other-call"]);
		childKept("a").note("a", ["child-call"]);
		expect(childKept("a").closed("a"), "its notes in both folders").toBe(2);
		expect([...childKept("a").spared(NONE).marks]).toEqual(["other-call"]);
		expect(reported).toEqual([]);
	});

	it("spares at a start every conversation folder's notes under the key, within their day", async () => {
		kept().note("a", ["realm-call"]);
		childKept("b").note("b", ["child-call"]);
		at += STRAY_FOR_MS / 2;
		childKept("c").note("c", ["newer-child-call"]);
		mkdirSync(join(stateDir, "no-notes"));
		const carried = { marks: new Set(["carried"]), groups: new Set([7]) };
		const spared = await sparedUnder(stateDir, carried, {
			report: (error) => reported.push(error),
			now: () => at,
		});
		expect([...spared.marks].sort()).toEqual([
			"carried",
			"child-call",
			"newer-child-call",
			"realm-call",
		]);
		expect([...spared.groups]).toEqual([7]);
		at += STRAY_FOR_MS / 2;
		const later = await sparedUnder(stateDir, NONE, {
			report: (error) => reported.push(error),
			now: () => at,
		});
		expect([...later.marks], "the older notes went after their day").toEqual([
			"newer-child-call",
		]);
		expect(reported).toEqual([]);
	});

	it("spares at a start only what is carried when the key has no engine folder yet", async () => {
		const spared = await sparedUnder(join(stateDir, "absent"), NONE, {
			report: (error) => reported.push(error),
		});
		expect(spared).toBe(NONE);
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

	it("waits at a start, rather than spare less, while a folder's notes fail to read for the moment", async () => {
		childKept("b").note("b", ["child-call"]);
		readFault.code = "EMFILE";
		const spared = await sparedUnder(stateDir, NONE, {
			report: (error) => reported.push(error),
			now: () => at,
		});
		expect(spared.unread, "whom to spare is not known").toBe(true);
	});

	it("waits at a start while one conversation folder's notes alone fail to read for the moment", async () => {
		kept().note("a", ["realm-call"]);
		childKept("b").note("b", ["child-call"]);
		childKept("c").note("c", ["other-child-call"]);
		readFault.code = "EMFILE";
		readFault.only = "b";
		const spared = await sparedUnder(stateDir, NONE, {
			report: (error) => reported.push(error),
			now: () => at,
		});
		expect(spared.unread, "whom to spare is not known").toBe(true);
	});

	it("drops at a close the notes it can read while another folder's fail for the moment", () => {
		kept().note("a", ["realm-call"]);
		childKept("a").note("a", ["child-call"]);
		readFault.code = "EMFILE";
		readFault.only = stateDir.split("/").at(-1);
		expect(childKept("a").closed("a"), "the child folder's one").toBe(1);
		readFault.code = undefined;
		expect(
			[...childKept("a").spared(NONE).marks],
			"the engine folder's note stays to its day's end",
		).toEqual(["realm-call"]);
		expect(reported, "the close left undone there is said").toEqual([
			expect.objectContaining({ message: expect.stringMatching(/end a's/) }),
		]);
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
		expect(reported, "the note and the close left undone are said").toEqual([
			expect.objectContaining({ message: expect.stringMatching(/note b's/) }),
			expect.objectContaining({ message: expect.stringMatching(/end c's/) }),
		]);
	});
});
