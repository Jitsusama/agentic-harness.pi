/**
 * A roster round's start reads the room its platform gives it, and says
 * when it started though that room couldn't be judged. The rules
 * themselves are pinned in round-room-by-platform.test.ts; this pins
 * that the start is wired to them, so reverting the wiring fails here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { awaitRosterStart } from "../../../../extensions/review-integration/tools/ask-round.ts";

let root: string;
const was: Record<string, string | undefined> = {};
const HOMES = ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"] as const;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "roster-start-"));
	for (const name of HOMES) {
		was[name] = process.env[name];
		process.env[name] = join(root, name);
	}
});

afterEach(() => {
	for (const name of HOMES) {
		const value = was[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

describe("a roster round's start", () => {
	it("asks the room it is given, and says a start its room couldn't judge", async () => {
		let asked = 0;
		const start = await awaitRosterStart("owner/repo#1", undefined, "council", {
			short: async () => {
				asked += 1;
				return undefined;
			},
			startedUnjudged: () => "It started unjudged.",
		});

		expect(asked, "the start read its room").toBeGreaterThan(0);
		expect(start.waited).toContain("It started unjudged.");
		await start.release?.();
	});
});
