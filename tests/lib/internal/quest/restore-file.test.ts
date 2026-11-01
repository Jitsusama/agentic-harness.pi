import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	carriedEntry,
	RESTORE_FILE_VERSION,
	type RestoreFile,
	restoreFileOf,
	restoreFilePath,
	writeRestoreFile,
} from "../../../../lib/internal/quest/restore-file.ts";
import {
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
});
