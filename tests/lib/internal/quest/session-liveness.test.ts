import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deriveLiveness,
	sessionActivity,
} from "../../../../lib/internal/quest/session-liveness";

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
});
