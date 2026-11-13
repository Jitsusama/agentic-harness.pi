import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	bootEndedBefore,
	carriedEntry,
	RESTORE_FILE_VERSION,
	type RestoreFile,
	releasedEntry,
	restoreFileOf,
	restoreFilePath,
	writeRestoreFile,
} from "../../../../lib/internal/quest/restore-file.ts";
import {
	closeRecord,
	openRecord,
	reopenRecord,
} from "../../../../lib/internal/quest/session-registry.ts";

/** A session's record as it stood when its pi last ran, in `boot`. */
function ranIn(sessionId: string, boot: string, questId?: string) {
	return openRecord({
		sessionId,
		instanceId: `inst-${sessionId}`,
		cwd: `/home/me/src/${sessionId}`,
		...(questId ? { questId } : {}),
		process: { hostId: "here", pid: 1, startToken: "t", bootToken: boot },
		now: new Date("2026-10-28T20:40:00Z"),
	});
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("the restore file", () => {
	it("offers what a power-off took away, though nothing stamped it, each at its last heartbeat", () => {
		const file = restoreFileOf(
			[
				{
					record: ranIn("01a17858-f49a", "last", "QEST-20261007-WCJQSG"),
					heartbeatAt: "2026-10-29T04:59:40Z",
				},
				{
					record: ranIn("01a1aaaa-bbbb", "last"),
					heartbeatAt: "2026-10-29T05:00:00Z",
				},
			],
			"this",
			(quest) =>
				quest === "QEST-20261007-WCJQSG" ? "Bootstrap optimus" : undefined,
		);

		expect(file).toEqual({
			v: RESTORE_FILE_VERSION,
			boot: "last",
			sessions: [
				{
					id: "01a1aaaa-bbbb",
					address: "AAAABBBB",
					title: "01a1aaaa-bbbb",
					cwd: "/home/me/src/01a1aaaa-bbbb",
					lostAt: "2026-10-29T05:00:00.000Z",
				},
				{
					id: "01a17858-f49a",
					address: "WCJQSG",
					title: "Bootstrap optimus",
					quest: "QEST-20261007-WCJQSG",
					cwd: "/home/me/src/01a17858-f49a",
					lostAt: "2026-10-29T04:59:40.000Z",
				},
			],
		});
	});

	it("says how each session was started, so one fenced comes back fenced", () => {
		const fenced = {
			...ranIn("01a1cccc-dddd", "last"),
			env: { PI_SANDBOX: "fence", PI_SPAWNER: "on" },
		};
		const plain = ranIn("01a1aaaa-bbbb", "last");
		const file = restoreFileOf(
			[
				{ record: fenced, heartbeatAt: "2026-10-29T05:00:00Z" },
				{ record: plain, heartbeatAt: "2026-10-29T05:00:00Z" },
			],
			"this",
		);
		const byId = new Map(file.sessions.map((entry) => [entry.id, entry]));
		expect(byId.get("01a1cccc-dddd")?.env).toEqual({
			PI_SANDBOX: "fence",
			PI_SPAWNER: "on",
		});
		expect(byId.get("01a1aaaa-bbbb")).not.toHaveProperty("env");
	});

	it("marks a session a shared host ran as hosted, so the launcher leaves it to the host", () => {
		const plain = ranIn("01a1cccc-dddd", "last");
		const inHost = openRecord({
			sessionId: "01a1eeee-ffff",
			instanceId: "inst-host",
			cwd: "/home/me/src/hosted",
			process: {
				hostId: "here",
				pid: 1,
				startToken: "t",
				bootToken: "last",
				hosted: {
					host: "home-background",
					session: "01a1eeee-ffff",
					owner: { pid: 1, startedAt: 1, startTicks: 1 },
				},
			},
			now: new Date("2026-10-28T20:40:00Z"),
		});
		const file = restoreFileOf(
			[
				{ record: plain, heartbeatAt: "2026-10-29T05:00:00Z" },
				{ record: inHost, heartbeatAt: "2026-10-29T05:00:00Z" },
			],
			"this",
		);
		const byId = new Map(file.sessions.map((entry) => [entry.id, entry]));
		expect(byId.get("01a1eeee-ffff")).toMatchObject({ hosted: true });
		expect(byId.get("01a1cccc-dddd")).not.toHaveProperty("hosted");
	});

	it("offers a session parked when the boot ended, marked parked, unless its quest is done", () => {
		const parked = (sessionId: string, questId: string, at: string) =>
			closeRecord(ranIn(sessionId, "last", questId), "parked", new Date(at));
		const file = restoreFileOf(
			[
				{
					record: ranIn("running", "last"),
					heartbeatAt: "2026-10-29T05:00:00Z",
				},
				{
					record: parked(
						"asleep",
						"QEST-20261106-AAAAAA",
						"2026-10-29T01:00:00Z",
					),
					heartbeatAt: "2026-10-29T01:00:00Z",
				},
				{
					record: parked(
						"done",
						"QEST-20261106-BBBBBB",
						"2026-10-29T02:00:00Z",
					),
					heartbeatAt: "2026-10-29T02:00:00Z",
				},
			],
			"this",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(quest) => quest !== "QEST-20261106-BBBBBB",
		);

		expect(file.sessions).toEqual([
			expect.objectContaining({ id: "running" }),
			{
				id: "asleep",
				address: "AAAAAA",
				title: "asleep",
				quest: "QEST-20261106-AAAAAA",
				cwd: "/home/me/src/asleep",
				lostAt: "2026-10-29T01:00:00.000Z",
				parked: true,
			},
		]);
	});

	it("drops a session once it runs again in this boot", () => {
		const back = reopenRecord(ranIn("back", "last"), {
			instanceId: "inst-now",
			process: { hostId: "here", pid: 2, startToken: "t", bootToken: "this" },
		});
		const file = restoreFileOf(
			[
				{ record: back, heartbeatAt: "2026-10-29T11:00:00Z" },
				{
					record: ranIn("unsaved", "last"),
					heartbeatAt: "2026-10-29T05:00:00Z",
				},
				{ record: ranIn("left", "last"), heartbeatAt: "2026-10-29T05:00:00Z" },
			],
			"this",
			undefined,
			(id) => id !== "unsaved",
		);

		expect(file.sessions.map((entry) => entry.id)).toEqual(["unsaved", "left"]);
	});

	it("offers one pi never saved to start afresh under its id, rather than leaving it out", () => {
		// A session that never answered has no file for `pi --session` to
		// resume, so it was left out and lost without a word (01a18f19, at
		// the 14:00 restart on 10-31).
		const file = restoreFileOf(
			[
				{
					record: ranIn("unsaved", "last", "QEST-20260626-P7CLU8"),
					heartbeatAt: "2026-10-29T05:00:00Z",
				},
				{ record: ranIn("saved", "last"), heartbeatAt: "2026-10-29T05:00:00Z" },
			],
			"this",
			undefined,
			(id) => id !== "unsaved",
		);

		expect(file.sessions).toEqual([
			expect.objectContaining({
				id: "unsaved",
				quest: "QEST-20260626-P7CLU8",
				fresh: true,
			}),
			expect.not.objectContaining({ fresh: expect.anything() }),
		]);
	});

	it("offers a window on another machine's session by its attach, beside this machine's sessions", () => {
		const attach = [
			"ssh",
			"-t",
			"equilibrius",
			"mycelium",
			"attach",
			"9f2c1a07",
		];
		const asked: (string | undefined)[] = [];
		const file = restoreFileOf([], "now", undefined, undefined, (lastBoot) => {
			asked.push(lastBoot);
			return {
				boot: "last",
				windows: [
					{
						id: "01a19000-mac1",
						address: "SAK9FZ",
						title: "π - Steer Across Machines",
						machine: "equilibrius",
						attach,
						cwd: "/home/me",
					},
				],
			};
		});

		// No local session was lost, so the note names the boot.
		expect(asked).toEqual([undefined]);
		expect(file).toEqual({
			v: RESTORE_FILE_VERSION,
			boot: "last",
			sessions: [
				{
					id: "01a19000-mac1",
					address: "SAK9FZ",
					title: "π - Steer Across Machines",
					cwd: "/home/me",
					lostAt: "",
					machine: "equilibrius",
					attach,
				},
			],
		});
	});

	it("offers a session carried home in this very boot, until a pi runs it here", () => {
		const carried = carriedEntry(
			{
				id: "01a19111-sbx1",
				quest: "QEST-20261025-85PKB2",
				from: "sandbox-7",
				at: "2026-10-30T22:20:00.000Z",
				file: "/carried/x.jsonl",
			},
			"/home/me/src/harness",
			(quest) => (quest === "QEST-20261025-85PKB2" ? "The Harness" : undefined),
		);
		const offered = restoreFileOf([], "now", undefined, undefined, undefined, [
			carried,
		]);

		expect(offered).toEqual({
			v: RESTORE_FILE_VERSION,
			sessions: [
				{
					id: "01a19111-sbx1",
					address: "85PKB2",
					title: "The Harness",
					quest: "QEST-20261025-85PKB2",
					cwd: "/home/me/src/harness",
					lostAt: "2026-10-30T22:20:00.000Z",
					carried: { from: "sandbox-7", at: "2026-10-30T22:20:00.000Z" },
				},
			],
		});
		const ran = restoreFileOf(
			[
				{
					record: ranIn("01a19111-sbx1", "now", "QEST-20261025-85PKB2"),
					heartbeatAt: "2026-10-30T22:21:00Z",
				},
			],
			"now",
			undefined,
			undefined,
			undefined,
			[carried],
		);
		expect(ran.sessions, "it ran here, so it isn't offered").toEqual([]);
	});

	it("offers a session its host let go, though it ran here, in place of its other entry", () => {
		const released = releasedEntry(
			{
				session: "01a1c1e7-rel1",
				sessionFile: "/home/me/.pi/agent/sessions/x/a.jsonl",
				cwd: "/home/me/src/harness",
				to: "pi",
				at: "2026-11-24T19:00:00.000Z",
				addresses: ["2QZBX9"],
				quest: "QEST-20261109-2QZBX9",
				from: "work-attended",
				pid: 4100,
			},
			(quest) => (quest === "QEST-20261109-2QZBX9" ? "K7" : undefined),
		);
		const file = restoreFileOf(
			[
				{
					record: ranIn("01a1c1e7-rel1", "last", "QEST-20261109-2QZBX9"),
					heartbeatAt: "2026-11-24T05:00:00Z",
				},
				{
					record: ranIn("01a1c1e7-rel2", "now"),
					heartbeatAt: "2026-11-24T19:00:00Z",
				},
			],
			"now",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			[released],
		);

		expect(file.sessions).toEqual([
			{
				id: "01a1c1e7-rel1",
				address: "2QZBX9",
				title: "K7",
				quest: "QEST-20261109-2QZBX9",
				cwd: "/home/me/src/harness",
				lostAt: "2026-11-24T19:00:00.000Z",
				released: { from: "work-attended", at: "2026-11-24T19:00:00.000Z" },
			},
		]);
	});

	it("is written whole where the launcher looks, its folder made if need be", () => {
		const home = mkdtempSync(join(tmpdir(), "restore-file-"));
		dirs.push(home);
		const path = restoreFilePath(home);

		writeRestoreFile(path, { v: RESTORE_FILE_VERSION, sessions: [] });

		expect(path).toBe(join(home, "pi", "restore.json"));
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			v: RESTORE_FILE_VERSION,
			sessions: [],
		});
	});

	it("leaves the file alone when it would say the same, so its watcher isn't woken", () => {
		const home = mkdtempSync(join(tmpdir(), "restore-file-"));
		dirs.push(home);
		const path = restoreFilePath(home);
		const file: RestoreFile = {
			v: RESTORE_FILE_VERSION,
			boot: "last",
			sessions: [],
		};
		writeRestoreFile(path, file);
		const first = statSync(path).ino;

		writeRestoreFile(path, file);
		expect(statSync(path).ino).toBe(first);

		writeRestoreFile(path, { ...file, boot: "another" });
		expect(statSync(path).ino).not.toBe(first);
	});

	it("keeps naming the boot that ended once its sessions all run again, rather than offering an older boot's", () => {
		// At 18:41 on 11-02 the last of 38 reopened sessions rewrote the file
		// to name a boot two before, since every record of the boot that
		// ended now carried this boot's token; the launcher, which keeps
		// places only for this boot and the one the file names, dropped the
		// ended boot's.
		const back = reopenRecord(ranIn("back", "last"), {
			instanceId: "inst-now",
			process: { hostId: "here", pid: 2, startToken: "t", bootToken: "this" },
		});
		const records = [
			{ record: back, heartbeatAt: "2026-10-29T11:00:00Z" },
			{ record: ranIn("old", "older"), heartbeatAt: "2026-10-28T21:00:00Z" },
		];

		const file = restoreFileOf(
			records,
			"this",
			undefined,
			undefined,
			undefined,
			[],
			"last",
		);

		expect(file).toEqual({
			v: RESTORE_FILE_VERSION,
			boot: "last",
			sessions: [],
		});
	});

	it("still offers what the named boot lost and hasn't run again", () => {
		const file = restoreFileOf(
			[
				{ record: ranIn("left", "last"), heartbeatAt: "2026-10-29T05:00:00Z" },
				{ record: ranIn("old", "older"), heartbeatAt: "2026-10-29T06:00:00Z" },
			],
			"this",
			undefined,
			undefined,
			undefined,
			[],
			"last",
		);

		expect(file.boot).toBe("last");
		expect(file.sessions.map((entry) => entry.id)).toEqual(["left"]);
	});

	it("takes the boot the file names only when this boot wrote it", () => {
		const home = mkdtempSync(join(tmpdir(), "restore-file-"));
		dirs.push(home);
		const path = restoreFilePath(home);
		writeRestoreFile(path, {
			v: RESTORE_FILE_VERSION,
			boot: "last",
			sessions: [],
		});
		const written = statSync(path).mtimeMs;

		expect(bootEndedBefore(path, "this", written - 1000)).toBe("last");
		// Written before this boot began, it names the boot before that.
		expect(bootEndedBefore(path, "this", written + 1000)).toBeUndefined();
		// A file naming this boot, or a machine that can't say when it
		// booted, leaves the boot to be worked out from the records.
		expect(bootEndedBefore(path, "last", written - 1000)).toBeUndefined();
		expect(bootEndedBefore(path, "this", undefined)).toBeUndefined();
		expect(bootEndedBefore(join(home, "none.json"), "this", 0)).toBeUndefined();
	});
});

describe("the restore file's placing and lines", () => {
	const lost = (sessionId: string, questId?: string) => ({
		record: ranIn(sessionId, "last", questId),
		heartbeatAt: "2026-10-29T05:00:00Z",
	});

	it("names the workspace each session's window opens on, by name", () => {
		const file = restoreFileOf(
			[lost("01a1aaaa-bbbb", "QEST-20261025-85PKB2"), lost("01a1cccc-dddd")],
			"this",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				workspaceOf: (questId) =>
					questId === "QEST-20261025-85PKB2" ? "WCJQSG" : undefined,
			},
		);
		const byId = new Map(file.sessions.map((entry) => [entry.id, entry]));

		expect(byId.get("01a1aaaa-bbbb")?.workspace).toBe("WCJQSG");
		expect(
			byId.get("01a1cccc-dddd"),
			"no quest, so no workspace",
		).not.toHaveProperty("workspace");
	});

	it("leaves out a session whose conversation another one coming back carries on", () => {
		const parked = {
			record: closeRecord(
				ranIn("01a1-old", "last", "QEST-1"),
				"parked",
				new Date("2026-10-29T04:00:00Z"),
			),
			heartbeatAt: "2026-10-29T04:00:00Z",
		};
		const file = restoreFileOf(
			[parked, lost("01a1-new", "QEST-1")],
			"this",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ parentOf: (id) => (id === "01a1-new" ? "01a1-old" : undefined) },
		);

		expect(
			file.sessions.map((entry) => entry.id),
			"the carried-on copy is offered",
		).toEqual(["01a1-new"]);
	});

	const parkedOld = {
		record: closeRecord(
			ranIn("01a1-old", "last", "QEST-1"),
			"parked",
			new Date("2026-10-29T04:00:00Z"),
		),
		heartbeatAt: "2026-10-29T04:00:00Z",
	};
	const carriedOnByNew = {
		parentOf: (id: string) => (id === "01a1-new" ? "01a1-old" : undefined),
	};
	const offered = (stored: Parameters<typeof restoreFileOf>[0]) =>
		restoreFileOf(
			stored,
			"this",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			carriedOnByNew,
		).sessions.map((entry) => entry.id);

	it("leaves it out while the session that carries it on runs", () => {
		const running = {
			record: ranIn("01a1-new", "this", "QEST-1"),
			heartbeatAt: "2026-10-29T05:00:00Z",
		};

		expect(offered([parkedOld, running]), "nothing to offer").toEqual([]);
	});

	it("offers it when nothing that carries it on comes back", () => {
		const quit = {
			record: closeRecord(
				ranIn("01a1-new", "last", "QEST-1"),
				"quit",
				new Date("2026-10-29T04:30:00Z"),
			),
			heartbeatAt: "2026-10-29T04:30:00Z",
		};

		expect(offered([parkedOld, quit]), "the line's one session").toEqual([
			"01a1-old",
		]);
	});
});
