import { describe, expect, it } from "vitest";
import {
	closeRecord,
	lastOpenAt,
	lastOpenOnQuest,
	openRecord,
	parseSessionRecord,
	pruneRecords,
	type SessionRecord,
	switchQuest,
} from "../../../../lib/internal/quest/session-registry";

const NOW = new Date("2026-07-28T18:00:00.000Z");
const LATER = new Date("2026-07-28T19:00:00.000Z");
const LATER_STILL = new Date("2026-07-28T20:00:00.000Z");

function opened(overrides: Partial<Parameters<typeof openRecord>[0]> = {}) {
	return openRecord({
		sessionId: "sess-1",
		instanceId: "inst-1",
		cwd: "/work",
		questId: "QEST-1",
		now: NOW,
		...overrides,
	});
}

describe("openRecord", () => {
	it("records the session as open on its quest", () => {
		const record: SessionRecord = opened();
		expect(record).toMatchObject({
			sessionId: "sess-1",
			instanceId: "inst-1",
			cwd: "/work",
			quest: "QEST-1",
			openedAt: NOW.toISOString(),
		});
		expect(record.closedAt).toBeUndefined();
	});

	it("carries the probeable identity a later reader needs", () => {
		const process = {
			hostId: "host-a",
			pid: 42,
			startToken: "tok",
			bootToken: "boot-1",
		};
		const terminal = {
			driverId: "wezterm",
			kind: "wezterm-pane",
			hostId: "host-a",
			scope: "/sock/1",
			value: "7",
		};
		const record = opened({ process, terminal });
		expect(record.process).toEqual(process);
		expect(record.terminal).toEqual(terminal);
	});

	it("omits identity a session could not capture rather than inventing it", () => {
		const record = opened();
		expect("process" in record).toBe(false);
		expect("terminal" in record).toBe(false);
	});
});

describe("closeRecord", () => {
	it("stamps a session whose tab went away with it", () => {
		const record = closeRecord(opened(), "quit", LATER);
		expect(record.closedAt).toBe(LATER.toISOString());
		expect(record.endReason).toBe("quit");
	});

	it("stamps a session swapped out of a tab that is still open", () => {
		// A reload, a session switch or a fork ends the conversation
		// without ending the tab, and only the tab's fate differs.
		const record = closeRecord(opened(), "swapped", LATER);
		expect(record.closedAt).toBe(LATER.toISOString());
		expect(record.endReason).toBe("swapped");
	});

	it("leaves an already-closed record where it stands", () => {
		// A late heartbeat or a second shutdown must not move the moment
		// the session actually ended.
		const first = closeRecord(opened(), "quit", LATER);
		const again = closeRecord(first, "swapped", LATER_STILL);
		expect(again.closedAt).toBe(LATER.toISOString());
		expect(again.endReason).toBe("quit");
	});
});

describe("parseSessionRecord", () => {
	it("reads back a record it wrote", () => {
		const record = closeRecord(
			switchQuest(opened(), "QEST-2", LATER),
			"quit",
			LATER_STILL,
		);
		const round = parseSessionRecord(JSON.parse(JSON.stringify(record)));
		expect(round).toEqual(record);
	});

	it("refuses a record missing the fields every reader depends on", () => {
		expect(parseSessionRecord({ sessionId: "sess-1" })).toBeUndefined();
		expect(parseSessionRecord(null)).toBeUndefined();
		expect(parseSessionRecord("sess-1")).toBeUndefined();
	});

	it("refuses a record whose end reason is not one we understand", () => {
		// A record we cannot interpret must not be treated as ended, since
		// that decides whether a tab is offered back to the user.
		const record = {
			...opened(),
			closedAt: LATER.toISOString(),
			endReason: "vanished",
		};
		expect(parseSessionRecord(record)).toBeUndefined();
	});
});

describe("pruneRecords", () => {
	const day = (n: number) =>
		new Date(`2026-07-${String(n).padStart(2, "0")}T18:00:00.000Z`);

	it("forgets a session closed longer ago than the window", () => {
		const old = closeRecord(opened({ sessionId: "old" }), "quit", day(1));
		const { kept, dropped } = pruneRecords([old], {
			now: day(20),
			retentionDays: 14,
		});
		expect(kept).toEqual([]);
		expect(dropped.map((r) => r.sessionId)).toEqual(["old"]);
	});

	it("keeps a session closed inside the window", () => {
		const recent = closeRecord(
			opened({ sessionId: "recent" }),
			"quit",
			day(18),
		);
		const { kept, dropped } = pruneRecords([recent], {
			now: day(20),
			retentionDays: 14,
		});
		expect(kept.map((r) => r.sessionId)).toEqual(["recent"]);
		expect(dropped).toEqual([]);
	});

	it("never forgets a session it cannot prove has ended", () => {
		// No close stamp means it may still be running, or it crashed and
		// no reader has repaired it yet. Either way it is recoverable,
		// and dropping it would lose a tab.
		const stillOpen = opened({ sessionId: "open" });
		const { kept, dropped } = pruneRecords([stillOpen], {
			now: day(28),
			retentionDays: 1,
		});
		expect(kept.map((r) => r.sessionId)).toEqual(["open"]);
		expect(dropped).toEqual([]);
	});

	it("keeps a session closed exactly on the window's edge", () => {
		const edge = closeRecord(opened({ sessionId: "edge" }), "quit", day(6));
		const { kept } = pruneRecords([edge], {
			now: day(20),
			retentionDays: 14,
		});
		expect(kept.map((r) => r.sessionId)).toEqual(["edge"]);
	});
});

describe("switchQuest", () => {
	it("moves the session and stamps when it left the old quest", () => {
		const record = switchQuest(opened(), "QEST-2", LATER);
		expect(record.quest).toBe("QEST-2");
		expect(record.previousQuests).toEqual({ "QEST-1": LATER.toISOString() });
	});

	it("stamps the quest it left when a session unloads to none", () => {
		const record = switchQuest(opened(), undefined, LATER);
		expect(record.quest).toBeUndefined();
		expect(record.previousQuests).toEqual({ "QEST-1": LATER.toISOString() });
	});

	it("keeps the earlier departure when a session returns and leaves again", () => {
		const left = switchQuest(opened(), "QEST-2", LATER);
		const back = switchQuest(left, "QEST-1", LATER_STILL);
		expect(back.quest).toBe("QEST-1");
		// It is on QEST-1 again, so QEST-1 is no longer a past quest,
		// and QEST-2 now carries the moment it was left.
		expect(back.previousQuests).toEqual({
			"QEST-2": LATER_STILL.toISOString(),
		});
	});

	it("does nothing when the session reloads the quest it is already on", () => {
		expect(switchQuest(opened(), "QEST-1", LATER)).toEqual(opened());
	});
});

describe("lastOpenOnQuest", () => {
	it("dates the quest a live session is on now as open", () => {
		expect(
			lastOpenOnQuest(opened(), "QEST-1", { live: true }, LATER_STILL),
		).toEqual({ at: LATER_STILL.toISOString(), exact: true });
	});

	it("dates a quest the session has left by when it left", () => {
		// The session is still open, but it is doing QEST-2's work now,
		// so QEST-1 should not claim it as currently open.
		const record = switchQuest(opened(), "QEST-2", LATER);
		expect(
			lastOpenOnQuest(record, "QEST-1", { live: true }, LATER_STILL),
		).toEqual({ at: LATER.toISOString(), exact: true });
	});

	it("says nothing about a quest the session was never on", () => {
		expect(
			lastOpenOnQuest(opened(), "QEST-9", { live: true }, LATER_STILL),
		).toBeUndefined();
	});
});

describe("lastOpenAt", () => {
	it("reads a live session as open right now", () => {
		expect(
			lastOpenAt(opened(), { live: true, heartbeatAt: "stale" }, LATER_STILL),
		).toEqual({ at: LATER_STILL.toISOString(), exact: true });
	});

	it("reads a cleanly ended session from its close stamp", () => {
		const record = closeRecord(opened(), "quit", LATER);
		expect(lastOpenAt(record, { live: false }, LATER_STILL)).toEqual({
			at: LATER.toISOString(),
			exact: true,
		});
	});

	it("dates a session that died without a close from its heartbeat", () => {
		// Nothing stamped this one, so the last time anything saw it
		// alive is the best answer available, and it is approximate.
		expect(
			lastOpenAt(
				opened(),
				{ live: false, heartbeatAt: LATER.toISOString() },
				LATER_STILL,
			),
		).toEqual({ at: LATER.toISOString(), exact: false });
	});

	it("falls back to when it opened if it never even heartbeat", () => {
		expect(lastOpenAt(opened(), { live: false }, LATER_STILL)).toEqual({
			at: NOW.toISOString(),
			exact: false,
		});
	});

	it("dates a record closed by a reader that found it gone as approximate", () => {
		// Nobody watched this one die; a reader stamped it with the last
		// moment anything saw it alive, so the stamp is a best estimate
		// even though it is recorded like any other close.
		const record = closeRecord(opened(), "died", LATER);
		expect(lastOpenAt(record, { live: false }, LATER_STILL)).toEqual({
			at: LATER.toISOString(),
			exact: false,
		});
	});

	it("prefers the close stamp over a heartbeat that outlived it", () => {
		// The heartbeat's own file is touched as the process winds down,
		// so an mtime a moment past the close is normal and must not
		// displace the exact answer.
		const record = closeRecord(opened(), "quit", LATER);
		expect(
			lastOpenAt(
				record,
				{ live: false, heartbeatAt: LATER_STILL.toISOString() },
				LATER_STILL,
			),
		).toEqual({ at: LATER.toISOString(), exact: true });
	});
});
