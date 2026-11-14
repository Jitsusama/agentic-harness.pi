import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	claimLease,
	keepOnce,
	LEASE_NAME,
	PASS_EVERY_MS,
	passDue,
	readStamp,
	stampedPass,
} from "../../../extensions/spend-workflow/keeper.ts";
import type { IndexOutcome } from "../../../extensions/spend-workflow/report.ts";

let scratch: string | null = null;

afterEach(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = null;
});

function folder(): string {
	scratch = mkdtempSync(join(tmpdir(), "ledger-keeper-"));
	return scratch;
}

const OUTCOME: IndexOutcome = {
	files: 3,
	scanned: 2,
	skipped: 1,
	lines: 40,
	unparseable: 0,
	inserted: 7,
	duplicates: 0,
	insertedCalls: 0,
	duplicateCalls: 0,
	insertedDropped: 0,
	resumed: 1,
	refused: [],
	seconds: 1.5,
};

const failing = (): Promise<IndexOutcome> =>
	Promise.reject(new Error("database is locked"));

describe("a stamped pass", () => {
	it("stamps when it ran and what it read", async () => {
		const dir = folder();

		await stampedPass(dir, "tool", async () => OUTCOME);

		expect(readStamp(dir)).toMatchObject({
			ok: true,
			by: "tool",
			pid: process.pid,
			scanned: 2,
			inserted: 7,
		});
	});

	it("stamps a failure and still throws it", async () => {
		const dir = folder();

		await expect(stampedPass(dir, "keeper", failing)).rejects.toThrow(
			"database is locked",
		);

		expect(readStamp(dir)).toMatchObject({
			ok: false,
			by: "keeper",
			error: "database is locked",
		});
	});
});

describe("when a pass is due", () => {
	const now = Date.parse("2026-11-10T20:00:00.000Z");
	const stamp = (at: string, ok = true) => ({
		at,
		ok,
		pid: 1,
		by: "tool" as const,
		seconds: 1,
	});

	it("is due when no pass has run", () => {
		expect(passDue(undefined, now), "with no stamp").toBe(true);
	});

	it("is due after a failed pass, however recent", () => {
		const failed = stamp("2026-11-10T19:59:00.000Z", false);
		expect(passDue(failed, now), "a minute after a failure").toBe(true);
	});

	it("waits out a recent pass and runs after an old one", () => {
		expect(passDue(stamp("2026-11-10T19:45:00.000Z"), now), "15 min").toBe(
			false,
		);
		expect(passDue(stamp("2026-11-10T10:19:00.000Z"), now), "10 h").toBe(true);
	});
});

describe("the lease", () => {
	it("is held by one taker at a time and free again once released", () => {
		const dir = folder();

		const release = claimLease(dir);
		expect(release, "the first taker").toBeDefined();
		expect(claimLease(dir), "a second while it is held").toBeUndefined();
		release?.();

		expect(claimLease(dir), "once released").toBeDefined();
	});

	it("is taken over from a holder that has gone", () => {
		const dir = folder();
		const gone = spawnSync("true").pid;
		writeFileSync(join(dir, LEASE_NAME), String(gone));

		expect(claimLease(dir), "over a dead pid").toBeDefined();
	});

	it("is taken over once older than any pass takes, whoever holds it", () => {
		const dir = folder();
		writeFileSync(join(dir, LEASE_NAME), String(process.ppid));

		const later = Date.now() + 2 * PASS_EVERY_MS;
		expect(claimLease(dir, later), "an old lease").toBeDefined();
	});
});

describe("the keeper", () => {
	it("runs a due pass in a still session and stamps it as its own", async () => {
		const dir = folder();
		let passes = 0;

		const did = await keepOnce({
			dir: () => dir,
			still: () => true,
			pass: async () => {
				passes += 1;
				return OUTCOME;
			},
		});

		expect(did).toBe("ran");
		expect(passes).toBe(1);
		expect(readStamp(dir)?.by).toBe("keeper");
		expect(existsSync(join(dir, LEASE_NAME)), "the lease is let go").toBe(
			false,
		);
	});

	it("leaves a session someone is working in alone", async () => {
		const dir = folder();

		const did = await keepOnce({
			dir: () => dir,
			still: () => false,
			pass: async () => OUTCOME,
		});

		expect(did).toBe("busy");
		expect(readStamp(dir), "no pass ran").toBeUndefined();
	});

	it("runs nothing while the last pass is recent", async () => {
		const dir = folder();
		await stampedPass(dir, "tool", async () => OUTCOME);

		const did = await keepOnce({
			dir: () => dir,
			still: () => true,
			pass: failing,
		});

		expect(did).toBe("current");
	});

	it("runs nothing while another keeper holds the lease", async () => {
		const dir = folder();
		const release = claimLease(dir);

		const did = await keepOnce({
			dir: () => dir,
			still: () => true,
			pass: async () => OUTCOME,
		});

		expect(did).toBe("held");
		release?.();
	});

	it("stamps a failed pass where readers look, and lets the lease go", async () => {
		const dir = folder();

		const did = await keepOnce({
			dir: () => dir,
			still: () => true,
			pass: failing,
		});

		expect(did).toBe("failed");
		expect(readStamp(dir)).toMatchObject({
			ok: false,
			error: "database is locked",
		});
		expect(claimLease(dir), "the lease is free").toBeDefined();
	});
});
