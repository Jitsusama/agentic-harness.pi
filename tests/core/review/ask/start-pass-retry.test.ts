/**
 * A round that passed a bar and then failed on its way out of the lock
 * still says it passed, when its next look finds the start it took.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	awaitCouncilStart,
	type RoomHeld,
} from "../../../../lib/core/review/ask/start-spacing.ts";

/** Whether the next write that leaves a pass on the line fails after. */
const passFault = vi.hoisted(() => ({ armed: false, thrown: 0 }));

vi.mock("../../../../lib/core/internal/file-lock.ts", async (original) => {
	type Lock = typeof import("../../../../lib/core/internal/file-lock.ts");
	const lock = await original<Lock>();
	return {
		...lock,
		withFileLock: async <T>(path: string, fn: () => Promise<T>) => {
			const kept = await lock.withFileLock(path, fn);
			if (passFault.armed && path.endsWith("line.json")) {
				const line = JSON.parse(readFileSync(path, "utf8"));
				if (line.started?.passed !== undefined) {
					passFault.armed = false;
					passFault.thrown += 1;
					throw new Error("the lock's release failed, as the test asked");
				}
			}
			return kept;
		},
	};
});

let folder: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "council-pass-retry-"));
	passFault.armed = true;
	passFault.thrown = 0;
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const onCpu: RoomHeld = {
	said: "CPU some avg60 was 46, at or past 40",
	readings: ["CPU some avg60"],
	passable: true,
};

// #2312's round 2: the look that found its own start again kept no
// word of the pass that took it.
describe("a pass whose look failed on its way out", () => {
	it("still says it passed when the next look finds its start", async () => {
		const start = await awaitCouncilStart(join(folder, "starts", "last.json"), {
			by: "ISXEG8",
			change: "o/r#ISXEG8",
			lookAgainMs: 10,
			alive: () => true,
			room: async () => onCpu,
			pass: { afterMs: 150, spacingMs: 300 },
		});

		expect(passFault.thrown, "the passing look failed once").toBe(1);
		expect(start.waited).toContain(
			"It started past the machine's bar on CPU some avg60",
		);
	});
});
