/**
 * A sealed quest's parked sessions are woken to end, and only its own.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ENDS_RATHER_THAN_PARKS,
	refuseParkOnceEnded,
	wakeSealedQuestParks,
	wakeWhy,
} from "../../../extensions/quest-workflow/ends-with-quest.ts";
import {
	type Parked,
	parkedWithQuest,
	writeParked,
} from "../../../lib/internal/session/park.ts";

const SEALED = "QEST-20261114-KFYFR8";
const OPEN = "QEST-20261114-0RF7H9";

let folder: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "wakes-parked-"));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

/** Park a session with a quest loaded, or none; answers its wake file. */
function park(session: string, address: string, quest?: string): string {
	const wake = join(folder, `${session}.wake`);
	const parked: Parked = {
		session,
		sessionFile: `/logs/${session}.jsonl`,
		cwd: "/src",
		addresses: [address, "78EB95D3"],
		...(quest ? { quest } : {}),
		parkedAt: "2026-11-14T17:40:00.000Z",
		pid: 4242,
		wake,
	};
	writeParked(parked, folder);
	return wake;
}

describe("the sessions parked with a quest", () => {
	it("are those whose marker names it, and no other", () => {
		park("s-1", "KFYFR8", SEALED);
		park("s-2", "0RF7H9", OPEN);
		park("s-3", "8W47JC");
		park("s-4", "765QSB", SEALED);
		expect(parkedWithQuest(SEALED, folder).map((p) => p.session)).toEqual([
			"s-1",
			"s-4",
		]);
	});

	it("are none where nothing has parked", () => {
		expect(parkedWithQuest(SEALED, join(folder, "never"))).toEqual([]);
	});
});

describe("a park asked of a session whose quest has ended", () => {
	const ask = (session: string, restart?: true) => ({
		session,
		refusals: [] as string[],
		...(restart ? { restart } : {}),
	});

	it("is refused, so the session ends rather than parks", () => {
		const asked = ask("s-1");
		refuseParkOnceEnded(asked, "s-1", () => true);
		expect(asked.refusals).toEqual([ENDS_RATHER_THAN_PARKS]);
	});

	it("is left be while the quest is open, for a restart, or for another session", () => {
		const open = ask("s-1");
		refuseParkOnceEnded(open, "s-1", () => false);
		const restart = ask("s-1", true);
		refuseParkOnceEnded(restart, "s-1", () => true);
		const other = ask("s-2");
		refuseParkOnceEnded(other, "s-1", () => true);
		expect(
			[open, restart, other].map((one) => one.refusals),
			"no refusal for an open quest, a restart or another session",
		).toEqual([[], [], []]);
	});
});

describe("waking a sealed quest's parked sessions", () => {
	it("wakes each through its holder's file, saying why, and leaves another quest's asleep", () => {
		const sealed = park("s-1", "KFYFR8", SEALED);
		park("s-2", "0RF7H9", OPEN);
		const said = wakeSealedQuestParks(SEALED, { folder });
		expect(said).toBe(
			"Woke its one parked session (KFYFR8), so it ends itself within about two minutes.",
		);
		expect(JSON.parse(readFileSync(sealed, "utf8"))).toMatchObject({
			session: "s-1",
			messageId: wakeWhy(SEALED),
		});
		expect(
			parkedWithQuest(OPEN, folder).map((p) => p.session),
			"the open quest's session is still parked, unwoken",
		).toEqual(["s-2"]);
	});

	it("names each it could not wake, with where to close it", () => {
		park("s-1", "KFYFR8", SEALED);
		park("s-4", "765QSB", SEALED);
		const said = wakeSealedQuestParks(SEALED, {
			folder,
			wake: (session) => {
				if (session === "s-4") throw new Error("holder gone");
				return true;
			},
		});
		expect(said).toBe(
			"Woke its one parked session (KFYFR8), so it ends itself within about two minutes. Could not wake 765QSB, parked with it, so it stays parked; close it from the launcher.",
		);
	});

	it("says how many it woke, each ending itself", () => {
		park("s-1", "KFYFR8", SEALED);
		park("s-4", "765QSB", SEALED);
		expect(wakeSealedQuestParks(SEALED, { folder })).toBe(
			"Woke its 2 parked sessions (KFYFR8, 765QSB), so each ends itself within about two minutes.",
		);
	});

	it("says nothing where none was parked with it", () => {
		park("s-2", "0RF7H9", OPEN);
		expect(wakeSealedQuestParks(SEALED, { folder })).toBeUndefined();
	});
});
