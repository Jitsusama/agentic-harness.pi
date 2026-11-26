import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveRecord } from "../../../../extensions/quest-workflow/sessions/records.ts";
import { lastBootRestorable } from "../../../../extensions/quest-workflow/sessions/restore.ts";
import {
	closeRecord,
	openRecord,
} from "../../../../lib/internal/quest/sessions/session-registry.ts";

const NOW = new Date("2026-07-28T18:00:00.000Z");

let stateHome: string;
let savedStateHome: string | undefined;

beforeEach(() => {
	savedStateHome = process.env.XDG_STATE_HOME;
	stateHome = mkdtempSync(join(tmpdir(), "carried-on-"));
	process.env.XDG_STATE_HOME = stateHome;
});

afterEach(() => {
	if (savedStateHome !== undefined) process.env.XDG_STATE_HOME = savedStateHome;
	else delete process.env.XDG_STATE_HOME;
	rmSync(stateHome, { recursive: true, force: true });
});

/** The minimum an openRecord call needs. */
function base(sessionId: string) {
	return {
		sessionId,
		instanceId: `inst-${sessionId}`,
		cwd: "/work",
		questId: "QEST-1",
		now: NOW,
	};
}

/** A session that ran in the boot that has since ended. */
function inLastBoot(sessionId: string) {
	return openRecord({
		...base(sessionId),
		process: {
			hostId: hostname(),
			pid: process.pid,
			startToken: "t",
			bootToken: "last",
		},
	});
}

// sess-old rolled over into sess-mid, and sess-mid into sess-new.
const parents = new Map([
	["sess-new", "sess-mid"],
	["sess-mid", "sess-old"],
]);
const parentOf = (sessionId: string) => parents.get(sessionId);
const ids = (records: readonly { sessionId: string }[]) =>
	records.map((record) => record.sessionId);

describe("a session whose conversation another carries on", () => {
	it("is not reopened beside the session that carries it on", () => {
		// On 13 November a copy resumed by mistake parked twice, and the
		// reboot's Reopen Them All opened it beside the session its
		// conversation had rolled over into two days before.
		saveRecord(closeRecord(inLastBoot("sess-old"), "parked", NOW));
		saveRecord(closeRecord(inLastBoot("sess-new"), "died", NOW));

		const lastBoot = lastBootRestorable(() => true, "this", parentOf);

		expect(ids(lastBoot.parked), "the carried-on copy came back").toEqual([]);
		expect(ids(lastBoot.offered)).toEqual(["sess-new"]);
	});

	it("walks no session's line when none is coming back", () => {
		// Every start writes the restore file, and each step of a line is a
		// log's header read on the thread.
		saveRecord(openRecord(base("sess-new")));
		const asked: string[] = [];
		const counted = (sessionId: string) => {
			asked.push(sessionId);
			return parentOf(sessionId);
		};

		const lastBoot = lastBootRestorable(() => true, "this", counted);

		expect(ids(lastBoot.offered)).toEqual([]);
		expect(asked).toEqual([]);
	});
});
