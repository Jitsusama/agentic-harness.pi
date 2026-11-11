import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	releasedHome,
	settleMoveNote,
} from "../../../extensions/quest-workflow/session-registry.ts";
import {
	type MoveNote,
	readMoveNote,
	writeMoveNote,
} from "../../../lib/internal/session/move.ts";

const RELEASED = "01a1be5c-fff0-70a1-9301-f505d5634b00";
const KEPT = "01a1be5c-fff0-70a1-9301-f505d5634bf6";

let folder: string;
let moves: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "move-notes-"));
	moves = join(folder, "moves");
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

/** A note a move left for `session`, bound for `to`. */
const note = (
	session: string,
	to: MoveNote["to"],
	from?: string,
): MoveNote => ({
	session,
	sessionFile: `/work/${session}.jsonl`,
	cwd: "/work",
	to,
	at: "2026-11-11T01:00:00.000Z",
	addresses: ["NOTEDD"],
	...(from ? { from } : {}),
	pid: 4242,
});

describe("releasedHome", () => {
	it("offers back what a host let go, but not one a host keeps again", () => {
		writeMoveNote(note(RELEASED, "pi", "work-background"), moves);
		writeMoveNote(note(KEPT, "pi", "work-background"), moves);
		writeMoveNote(note("arriving", "attended"), moves);

		const offered = releasedHome(
			join(folder, "quests"),
			moves,
			() => new Map([[KEPT, "work-attended"]]),
		);

		expect(offered.map((entry) => entry.id)).toEqual([RELEASED]);
	});
});

describe("settleMoveNote", () => {
	it("takes any note away once plain pi has the session", () => {
		writeMoveNote(note("plain", "attended"), moves);
		settleMoveNote("plain", false, moves);
		expect(readMoveNote("plain", moves)).toBeUndefined();
	});

	it("in a host, takes a release's note away but leaves one for a host", () => {
		writeMoveNote(note("released", "pi", "work-background"), moves);
		writeMoveNote(note("arriving", "attended"), moves);
		settleMoveNote("released", true, moves);
		settleMoveNote("arriving", true, moves);
		expect(readMoveNote("released", moves)).toBeUndefined();
		expect(readMoveNote("arriving", moves)?.to).toBe("attended");
	});
});
