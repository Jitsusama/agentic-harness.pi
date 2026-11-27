/**
 * A council whose reviewers run on a room waits on none of this
 * machine's bars: its reviewers load and think there, so this machine's
 * memory and CPU say nothing of whether they can start. It still takes
 * its place in the line. The start's wiring can't be driven without a
 * room, so the order is read from the round's source, as
 * refuses-a-prompt-too-large.test.ts reads it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	awaitRosterStart,
	ROOM_ROUND,
} from "../../../../extensions/review-integration/tools/ask-round.ts";
import { askFunctions } from "./ask-source.ts";

let root: string;
const was: Record<string, string | undefined> = {};
const HOMES = ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"] as const;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "room-round-"));
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

describe("a council whose reviewers run on a room", () => {
	it("is never held by its room, saying nothing of this machine", async () => {
		expect(await ROOM_ROUND.short()).toBeUndefined();
		const start = await awaitRosterStart(
			"owner/repo#1",
			undefined,
			"council",
			ROOM_ROUND,
		);

		expect(start.cancelled).toBeUndefined();
		expect(start.waited).toBeUndefined();
		await start.release?.();
	});

	it("decides its room before it takes a start, and waits on the room's bars then", () => {
		const body = askFunctions().get("councilRound") ?? "";
		const decided = body.indexOf("await roomFor(");
		const started = body.search(
			/await awaitRosterStart\([^;]*room === undefined \? undefined : ROOM_ROUND/,
		);

		expect(decided, "councilRound decides the room").toBeGreaterThan(-1);
		expect(started, "the start is given the room round's bars").toBeGreaterThan(
			decided,
		);
	});

	it("is the room both council rounds start their reviewers on", () => {
		const functions = askFunctions();
		for (const name of ["askCouncil", "startRound"]) {
			const body = functions.get(name) ?? "";
			expect(body, `${name} reads the room councilRound chose`).toMatch(
				/const \{[^}]*\broom\b[^}]*\} = set;/,
			);
			expect(body, `${name} doesn't decide a room of its own`).not.toContain(
				"await roomFor(",
			);
		}
	});
});
