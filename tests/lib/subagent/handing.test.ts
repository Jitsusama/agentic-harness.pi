/**
 * Who a moved fleet's subagents answer to: a hand-over for as long as
 * the move, then the conversation that took it up.
 *
 * Every reader of `parent.json` decides from it whether to stop a
 * child, so a half-written or malformed file must read as none, and a
 * hand-over must last exactly as long as the move and its margin.
 */
import {
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	answersTo,
	HANDING_MARGIN_MS,
	HANDING_MOST_MS,
	handingNow,
	PARENT_FILE,
	parentPath,
	readParent,
	removeParent,
	stillHanding,
	writeParent,
} from "../../../lib/subagent/handing.ts";

const OWNER_MODE = 0o600;
const PERMISSION_BITS = 0o777;

/** When the fleet was let go, in these tests. */
const SINCE = Date.parse("2026-11-12T10:00:00.000Z");
const note = { session: "conv-1", folder: "/run/moves" };
const owner = { pid: 4242, startedAt: 1_760_000_000_000 };

let runDir: string;

beforeEach(() => {
	runDir = mkdtempSync(join(tmpdir(), "handing-"));
});

afterEach(() => {
	rmSync(runDir, { recursive: true, force: true });
});

describe("parent.json", () => {
	it("is written whole, readable by this user alone, with nothing left beside it", () => {
		writeParent(runDir, { handing: handingNow(note, SINCE) });

		expect(statSync(parentPath(runDir)).mode & PERMISSION_BITS).toBe(
			OWNER_MODE,
		);
		expect(readdirSync(runDir)).toEqual([PARENT_FILE]);
		expect(readParent(runDir)).toEqual({
			handing: {
				since: "2026-11-12T10:00:00.000Z",
				note,
				mostMs: HANDING_MOST_MS,
				marginMs: HANDING_MARGIN_MS,
			},
		});
	});

	it("is written for a run no supervisor has started yet", () => {
		const notYet = join(runDir, "runs", "fleet-a");

		writeParent(notYet, { owner });

		expect(readParent(notYet)).toEqual({ owner });
	});

	it("reads back an owner written over a hand-over", () => {
		writeParent(runDir, { handing: handingNow(note, SINCE) });
		writeParent(runDir, { owner });

		expect(readParent(runDir)).toEqual({ owner });
	});

	it("reads as none when absent, half-written, or naming an owner it can't believe", () => {
		expect(readParent(runDir)).toBeUndefined();
		writeFileSync(parentPath(runDir), '{"handing":{"since":');
		expect(readParent(runDir)).toBeUndefined();
		writeFileSync(parentPath(runDir), JSON.stringify({ owner: { pid: 7 } }));
		expect(readParent(runDir)).toBeUndefined();
		writeFileSync(
			parentPath(runDir),
			JSON.stringify({ handing: { ...handingNow(note), note: {} } }),
		);
		expect(readParent(runDir)).toBeUndefined();
	});

	it("goes once the summary is said", () => {
		writeParent(runDir, { owner });
		removeParent(runDir);

		expect(readdirSync(runDir)).toEqual([]);
		expect(() => removeParent(runDir)).not.toThrow();
	});
});

describe("a hand-over, as a supervisor watching the note sees it", () => {
	const handing = handingNow(note, SINCE);

	it("holds for its margin after it was let go, when the note is never seen", () => {
		expect(
			stillHanding(handing, SINCE + HANDING_MARGIN_MS - 1, undefined),
			"held within the margin",
		).toBe(true);
		expect(
			stillHanding(handing, SINCE + HANDING_MARGIN_MS, undefined),
			"let go at the margin",
		).toBe(false);
	});

	it("holds while the note is out, and for its margin after it was last seen", () => {
		const lastSeen = SINCE + 30 * 60_000;

		expect(
			stillHanding(handing, lastSeen, lastSeen),
			"held while the note is out",
		).toBe(true);
		expect(
			stillHanding(handing, lastSeen + HANDING_MARGIN_MS - 1, lastSeen),
			"held within the margin after the note was last seen",
		).toBe(true);
		expect(
			stillHanding(handing, lastSeen + HANDING_MARGIN_MS, lastSeen),
			"let go at the margin after the note was last seen",
		).toBe(false);
	});

	it("never outlasts the longest move and its margin, however long the note stays out", () => {
		const end = SINCE + HANDING_MOST_MS + HANDING_MARGIN_MS;

		expect(
			stillHanding(handing, end - 1, end - 1),
			"held just short of the longest move and its margin",
		).toBe(true);
		expect(
			stillHanding(handing, end, end),
			"let go at the longest move and its margin",
		).toBe(false);
	});
});

describe("who a run answers to, as the sweep reads it", () => {
	it("is nobody's while the note is out, or within the longest move and margin", () => {
		writeParent(runDir, { handing: handingNow(note, SINCE) });
		const end = SINCE + HANDING_MOST_MS + HANDING_MARGIN_MS;

		expect(answersTo(runDir, end + 1, () => true)).toBe("handing");
		expect(answersTo(runDir, end - 1, () => false)).toBe("handing");
		expect(answersTo(runDir, end, () => false)).toBeUndefined();
	});

	it("is the owner that took it up", () => {
		writeParent(runDir, { owner });

		expect(answersTo(runDir)).toEqual(owner);
	});

	it("is undecided for a run never handed on", () => {
		expect(answersTo(runDir)).toBeUndefined();
	});
});
