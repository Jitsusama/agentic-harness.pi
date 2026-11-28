/**
 * A Mac's round that has taken its start but not yet made its folder
 * counts as a round just started, until a folder shows it, it gives the
 * start back, or its mark ages out; and a start given back takes its
 * mark with it.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MARK_HELD_FOR_MS,
	markStart,
	roundsStartingOrRunning,
	roundsTakingStart,
} from "../../../../extensions/review-integration/round-starting.ts";
import { markedWhileStarting } from "../../../../extensions/review-integration/tools/ask-round.ts";

const AT = Date.parse("2026-11-28T17:00:00.000Z");

/** A roster folder's name for a round started at `at`. */
function councilAt(at: number): string {
	const stamp = new Date(at)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(".", "")
		.replace("Z", "");
	return `council-${stamp}-000001`;
}

let stateDir: string;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "round-starting-"));
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

/** Makes the folder a round started at `at` leaves under the transcripts. */
function folderAt(at: number): void {
	mkdirSync(join(stateDir, "runs", councilAt(at)), { recursive: true });
}

describe("rounds taking their start", () => {
	it("counts a start with no folder yet as a round just started", async () => {
		await markStart(stateDir, AT);
		const taking = await roundsTakingStart(stateDir, AT + 4 * 60_000);
		expect(taking).toEqual([
			expect.objectContaining({ reviewersRunning: 0, runningMs: 4 * 60_000 }),
		]);
	});

	it("stops counting it once a folder named at or after it shows it", async () => {
		await markStart(stateDir, AT);
		folderAt(AT + 90_000);
		expect(await roundsTakingStart(stateDir, AT + 4 * 60_000)).toEqual([]);
	});

	it("never takes a folder from before the start as showing it", async () => {
		await markStart(stateDir, AT);
		folderAt(AT - 60_000);
		expect(await roundsTakingStart(stateDir, AT + 60_000)).toHaveLength(1);
	});

	it("lets one folder show only one of two starts", async () => {
		await markStart(stateDir, AT);
		await markStart(stateDir, AT + 3 * 60_000);
		folderAt(AT + 4 * 60_000);
		const taking = await roundsTakingStart(stateDir, AT + 5 * 60_000);
		expect(taking.map((round) => round.runningMs)).toEqual([2 * 60_000]);
	});

	it("drops a mark past its hold, as a round that died before its reviewers", async () => {
		await markStart(stateDir, AT);
		const taking = await roundsTakingStart(stateDir, AT + MARK_HELD_FOR_MS);
		expect(taking).toEqual([]);
		expect(readdirSync(join(stateDir, "starting"))).toEqual([]);
	});

	it("counts nothing where no round has left a mark", async () => {
		expect(await roundsTakingStart(stateDir, AT)).toEqual([]);
	});

	// The #2454 council's gap: a round granted its start was seen by
	// neither the count nor the age until its folder was made.
	it("are counted with the rounds running when a Mac judges another start", async () => {
		await markStart(stateDir);
		const counted = await roundsStartingOrRunning(stateDir);
		expect(counted).toEqual([expect.objectContaining({ reviewersRunning: 0 })]);
	});
});

describe("a start marked while it is taken", () => {
	it("takes its mark back with the start", async () => {
		let given = 0;
		const start = await markedWhileStarting(
			{
				release: async () => {
					given += 1;
				},
			},
			() => markStart(stateDir, AT),
		);
		expect(await roundsTakingStart(stateDir, AT + 60_000)).toHaveLength(1);
		await start.release?.();
		expect(given).toBe(1);
		expect(await roundsTakingStart(stateDir, AT + 60_000)).toEqual([]);
	});

	it("leaves a cancelled start unmarked", async () => {
		await markedWhileStarting({ cancelled: "stopped" }, () =>
			markStart(stateDir, AT),
		);
		expect(await roundsTakingStart(stateDir, AT + 60_000)).toEqual([]);
	});

	it("still starts when its mark can't be written", async () => {
		const start = { waited: "waited a minute" };
		const marked = await markedWhileStarting(start, () =>
			Promise.reject(new Error("read-only")),
		);
		expect(marked).toBe(start);
	});
});
