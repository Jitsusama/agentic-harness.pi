import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deriveLiveness,
	indexSessionFiles,
	prunePhantomSessions,
	questLastActivity,
	sessionActivity,
} from "../../../../lib/internal/quest/session-liveness";
import type { QuestSession } from "../../../../lib/quest/types";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "sess-live-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeSession(
	id: string,
	encodedCwd: string,
	entries: object[],
): Promise<void> {
	const sub = join(dir, encodedCwd);
	await mkdir(sub, { recursive: true });
	const body = entries.map((e) => JSON.stringify(e)).join("\n");
	await writeFile(join(sub, `2026-06-04T10-00-00-000Z_${id}.jsonl`), body);
}

describe("sessionActivity", () => {
	it("returns undefined when no file matches the id", async () => {
		await writeSession("aaa", "--cwd--", [
			{ timestamp: "2026-06-04T10:00:00.000Z" },
		]);
		expect(sessionActivity("missing", dir)).toBeUndefined();
	});

	it("reports the newest entry timestamp from an ISO-stamped session", async () => {
		await writeSession("019eabc", "--Users-me-proj--", [
			{ timestamp: "2026-06-04T10:00:00.000Z" },
			{ timestamp: "2026-06-04T11:30:00.000Z" },
		]);
		const result = sessionActivity("019eabc", dir);
		expect(result?.lastActivity).toBe("2026-06-04T11:30:00.000Z");
		expect(result?.path).toContain("019eabc");
	});

	it("parses an epoch-millisecond timestamp", async () => {
		const ms = Date.UTC(2026, 5, 4, 12, 0, 0);
		await writeSession("019epoch", "--c--", [{ timestamp: ms }]);
		const result = sessionActivity("019epoch", dir);
		expect(result?.lastActivity).toBe(new Date(ms).toISOString());
	});
});

describe("questLastActivity", () => {
	it("returns undefined when no session has a log", () => {
		expect(
			questLastActivity(
				[{ id: "gone", status: "active" }],
				indexSessionFiles(dir),
			),
		).toBeUndefined();
	});

	it("returns the newest activity across sessions", async () => {
		await writeSession("019older", "--a--", [
			{ timestamp: "2026-06-04T09:00:00.000Z" },
		]);
		await writeSession("019newer", "--b--", [
			{ timestamp: "2026-06-04T15:30:00.000Z" },
		]);
		const last = questLastActivity(
			[
				{ id: "019older", status: "detached" },
				{ id: "019newer", status: "detached" },
			],
			indexSessionFiles(dir),
		);
		expect(last).toBe("2026-06-04T15:30:00.000Z");
	});
});

describe("newestTimestamp via sessionActivity", () => {
	it("returns the maximum timestamp even when the last line is out of order", async () => {
		// A late-arriving entry with an earlier timestamp lands last in
		// the file; the newest activity must still be the real maximum.
		await writeSession("019ooo", "--c--", [
			{ timestamp: "2026-06-04T10:00:00.000Z" },
			{ timestamp: "2026-06-04T18:00:00.000Z" },
			{ timestamp: "2026-06-04T11:00:00.000Z" },
		]);
		expect(sessionActivity("019ooo", dir)?.lastActivity).toBe(
			"2026-06-04T18:00:00.000Z",
		);
	});
});

describe("deriveLiveness", () => {
	const now = new Date("2026-06-04T12:00:00.000Z");

	it("reports detached when the session status is detached", async () => {
		await writeSession("019det", "--c--", [
			{ timestamp: "2026-06-04T11:59:00.000Z" },
		]);
		const view = deriveLiveness({ id: "019det", status: "detached" }, dir, now);
		expect(view.liveness).toBe("detached");
		expect(view.lastActivity).toBe("2026-06-04T11:59:00.000Z");
	});

	it("reports dead when no log file exists", () => {
		const view = deriveLiveness({ id: "gone", status: "active" }, dir, now);
		expect(view.liveness).toBe("dead");
		expect(view.lastActivity).toBeUndefined();
	});

	it("reports live for recent activity", async () => {
		await writeSession("019live", "--c--", [
			{ timestamp: "2026-06-04T11:58:00.000Z" },
		]);
		const view = deriveLiveness({ id: "019live", status: "active" }, dir, now);
		expect(view.liveness).toBe("live");
	});

	it("reports idle for stale activity", async () => {
		await writeSession("019idle", "--c--", [
			{ timestamp: "2026-06-04T10:00:00.000Z" },
		]);
		const view = deriveLiveness({ id: "019idle", status: "active" }, dir, now);
		expect(view.liveness).toBe("idle");
	});

	it("matches the directory-walk result when given a prebuilt index", async () => {
		await writeSession("019live", "--c--", [
			{ timestamp: "2026-06-04T11:58:00.000Z" },
		]);
		await writeSession("019idle", "--d--", [
			{ timestamp: "2026-06-04T10:00:00.000Z" },
		]);
		const index = indexSessionFiles(dir);
		for (const id of ["019live", "019idle", "gone"]) {
			const session = { id, status: "active" as const };
			expect(deriveLiveness(session, dir, now, index)).toEqual(
				deriveLiveness(session, dir, now),
			);
		}
	});

	it("resolves activity from the index without reading the store directory", async () => {
		await writeSession("019live", "--c--", [
			{ timestamp: "2026-06-04T11:58:00.000Z" },
		]);
		const index = indexSessionFiles(dir);
		// A bogus sessionDir would make the directory-walk path fail to
		// find the log; with the index, liveness still resolves.
		const view = deriveLiveness(
			{ id: "019live", status: "active" },
			"/nonexistent",
			now,
			index,
		);
		expect(view.liveness).toBe("live");
	});
});

describe("prunePhantomSessions", () => {
	const s = (id: string, status: QuestSession["status"]): QuestSession => ({
		id,
		started: "2026-06-04T10:00:00.000Z",
		status,
	});

	it("removes detached sessions that have no log", () => {
		const sessions = [s("phantom", "detached"), s("real", "active")];
		const { kept, removed } = prunePhantomSessions(
			sessions,
			(id) => id !== "phantom",
		);
		expect(kept.map((x) => x.id)).toEqual(["real"]);
		expect(removed.map((x) => x.id)).toEqual(["phantom"]);
	});

	it("keeps a detached session that still has a log", () => {
		const sessions = [s("ended", "detached")];
		const { kept, removed } = prunePhantomSessions(sessions, () => true);
		expect(kept.map((x) => x.id)).toEqual(["ended"]);
		expect(removed).toEqual([]);
	});

	it("never removes an active session even without a log", () => {
		const sessions = [s("current", "active")];
		const { kept, removed } = prunePhantomSessions(sessions, () => false);
		expect(kept.map((x) => x.id)).toEqual(["current"]);
		expect(removed).toEqual([]);
	});

	it("returns everything kept when nothing is a phantom", () => {
		const sessions = [s("a", "active"), s("b", "detached")];
		const { kept, removed } = prunePhantomSessions(sessions, () => true);
		expect(kept).toHaveLength(2);
		expect(removed).toEqual([]);
	});
});
