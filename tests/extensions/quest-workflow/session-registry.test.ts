import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	endReasonForShutdown,
	forgetRecord,
	loadRecords,
	observeRecords,
	readRecord,
	recordSessionEnd,
	recordSessionOnQuest,
	saveRecord,
	sessionRegistryDir,
	startHeartbeat,
	stopHeartbeat,
	touchHeartbeat,
} from "../../../extensions/quest-workflow/session-registry";
import { currentProcessIdentity } from "../../../lib/internal/quest/process-liveness";
import { openRecord } from "../../../lib/internal/quest/session-registry";

let stateHome: string;
let savedStateHome: string | undefined;

const NOW = new Date("2026-07-28T18:00:00.000Z");

/** A record for a session running in this very process, so it probes live. */
function liveSession(sessionId = "sess-live") {
	return openRecord({
		sessionId,
		instanceId: "inst-1",
		cwd: "/work",
		questId: "QEST-1",
		...(currentProcessIdentity() ? { process: currentProcessIdentity() } : {}),
		now: NOW,
	});
}

/**
 * A record for a session that died with the machine it ran on.
 *
 * Keyed on the boot rather than a made-up pid: a pid nobody holds is
 * only reliably "gone" if ps says so cleanly, and an out-of-range one
 * reads as unknown by design, since a diagnostic means ps could not
 * answer. A record from an earlier boot is dead with no probe at all,
 * which is both deterministic here and the real crash case.
 */
function sessionFromPreviousBoot(sessionId = "sess-dead") {
	return openRecord({
		sessionId,
		instanceId: "inst-2",
		cwd: "/work",
		questId: "QEST-2",
		process: {
			hostId: hostname(),
			pid: process.pid,
			startToken: "Tue Jul 28 10:00:00 2026",
			bootToken: "a-boot-that-has-since-ended",
		},
		now: NOW,
	});
}

beforeEach(() => {
	savedStateHome = process.env.XDG_STATE_HOME;
	stateHome = mkdtempSync(join(tmpdir(), "session-registry-"));
	process.env.XDG_STATE_HOME = stateHome;
});

afterEach(() => {
	if (savedStateHome !== undefined) process.env.XDG_STATE_HOME = savedStateHome;
	else delete process.env.XDG_STATE_HOME;
	rmSync(stateHome, { recursive: true, force: true });
});

describe("the record store", () => {
	it("reads back what it wrote, dated by the file's own mtime", () => {
		saveRecord(liveSession());
		const stored = loadRecords();
		expect(stored).toHaveLength(1);
		expect(stored[0]?.record.sessionId).toBe("sess-live");
		expect(Date.parse(stored[0]?.heartbeatAt ?? "")).not.toBeNaN();
	});

	it("reads an empty registry as nothing recorded", () => {
		expect(loadRecords()).toEqual([]);
	});

	it("skips a corrupt record rather than going blind to the rest", () => {
		saveRecord(liveSession());
		writeFileSync(join(sessionRegistryDir(), "broken.json"), "{not json");
		writeFileSync(join(sessionRegistryDir(), "wrong.json"), '{"sessionId":1}');
		expect(loadRecords().map((s) => s.record.sessionId)).toEqual(["sess-live"]);
	});

	it("refuses a session id that would address a file outside the registry", () => {
		expect(readRecord("../../escape")).toBeUndefined();
	});

	it("forgets a record on request", () => {
		saveRecord(liveSession());
		forgetRecord("sess-live");
		expect(loadRecords()).toEqual([]);
	});
});

describe("the heartbeat", () => {
	it("moves the record's date without rewriting it", async () => {
		saveRecord(liveSession());
		const before = loadRecords()[0];
		await new Promise((resolve) => setTimeout(resolve, 1100));
		touchHeartbeat("sess-live");
		const after = loadRecords()[0];
		expect(after?.heartbeatAt).not.toBe(before?.heartbeatAt);
		expect(after?.record).toEqual(before?.record);
	});

	it("says nothing when there is no record to touch", () => {
		expect(() => touchHeartbeat("sess-missing")).not.toThrow();
	});

	it("keeps dating the record while the session runs", async () => {
		saveRecord(liveSession());
		const before = loadRecords()[0]?.heartbeatAt;
		startHeartbeat("sess-live", 20);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		stopHeartbeat();
		expect(loadRecords()[0]?.heartbeatAt).not.toBe(before);
	});

	it("stops the moment it is told to, so a late tick cannot re-date a closed record", async () => {
		saveRecord(liveSession());
		startHeartbeat("sess-live", 20);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		stopHeartbeat();
		const settled = loadRecords()[0]?.heartbeatAt;
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(loadRecords()[0]?.heartbeatAt).toBe(settled);
	});
});

describe("following a session onto its quests", () => {
	const onQuest = (questId: string, now: Date) =>
		recordSessionOnQuest(
			{
				sessionId: "sess-1",
				cwd: "/work",
				questId,
				instanceId: "inst-1",
			},
			now,
		);

	it("opens a record the first time a session loads a quest", () => {
		onQuest("QEST-1", NOW);
		expect(readRecord("sess-1")).toMatchObject({
			quest: "QEST-1",
			cwd: "/work",
			instanceId: "inst-1",
			openedAt: NOW.toISOString(),
		});
	});

	it("moves an existing record rather than opening a second one", () => {
		onQuest("QEST-1", NOW);
		const later = new Date("2026-07-28T19:00:00.000Z");
		onQuest("QEST-2", later);
		expect(loadRecords()).toHaveLength(1);
		expect(readRecord("sess-1")).toMatchObject({
			quest: "QEST-2",
			openedAt: NOW.toISOString(),
			previousQuests: { "QEST-1": later.toISOString() },
		});
	});
});

describe("endReasonForShutdown", () => {
	it("ends the record when the process quits", () => {
		expect(endReasonForShutdown("quit")).toBe("quit");
	});

	it("leaves the record alone on a reload", () => {
		// A reload rebuilds the extensions around the same session in the
		// same process. Nothing ended, so nothing should be stamped.
		expect(endReasonForShutdown("reload")).toBeUndefined();
	});

	it("ends the session but not the tab when the conversation is replaced", () => {
		for (const reason of ["new", "resume", "fork"]) {
			expect(endReasonForShutdown(reason)).toBe("swapped");
		}
	});
});

describe("observing the open records", () => {
	it("closes a session whose process is gone, dated by its heartbeat", () => {
		// A tab killed with its terminal never runs its own shutdown, so
		// nothing but a reader will ever close this record.
		saveRecord(sessionFromPreviousBoot());
		const stored = loadRecords();
		const { repaired } = observeRecords(stored);
		expect(repaired.map((r) => r.sessionId)).toEqual(["sess-dead"]);
		expect(repaired[0]?.endReason).toBe("died");
		expect(repaired[0]?.closedAt).toBe(stored[0]?.heartbeatAt);
		expect(readRecord("sess-dead")?.closedAt).toBeDefined();
	});

	it("leaves a session whose process is still running", () => {
		saveRecord(liveSession());
		expect(observeRecords(loadRecords()).repaired).toEqual([]);
		expect(readRecord("sess-live")?.closedAt).toBeUndefined();
	});

	it("re-dates a live session, so an idle tab is kept current by whoever asks", async () => {
		saveRecord(liveSession());
		const before = loadRecords()[0]?.heartbeatAt;
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(observeRecords(loadRecords()).refreshed).toEqual(["sess-live"]);
		expect(loadRecords()[0]?.heartbeatAt).not.toBe(before);
	});

	it("leaves a session it cannot probe rather than calling it dead", () => {
		// No process identity means nothing to ask, and an inability to
		// observe must never read as death.
		saveRecord(
			openRecord({
				sessionId: "sess-blind",
				instanceId: "inst-3",
				cwd: "/work",
				now: NOW,
			}),
		);
		expect(observeRecords(loadRecords()).repaired).toEqual([]);
	});

	it("leaves an already-closed record where it stands", () => {
		saveRecord(sessionFromPreviousBoot());
		recordSessionEnd("sess-dead", "quit", new Date("2026-07-28T19:00:00.000Z"));
		expect(observeRecords(loadRecords()).repaired).toEqual([]);
		expect(readRecord("sess-dead")?.endReason).toBe("quit");
	});
});
