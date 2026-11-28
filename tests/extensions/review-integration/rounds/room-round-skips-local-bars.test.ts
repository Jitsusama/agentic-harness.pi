/**
 * A council whose reviewers run on a room waits on none of this
 * machine's bars: its reviewers load and think there, so this machine's
 * memory and CPU say nothing of whether they can start. It still takes
 * its place in the line, ahead of the rounds those bars hold, and keeps
 * the spacing. The round's own wiring can't be driven without a room,
 * so where the room is read is checked from the round's source, as
 * refuses-a-prompt-too-large.test.ts reads it.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { councilStartsPath } from "../../../../extensions/review-integration/engine.ts";
import {
	awaitRosterStart,
	ROOM_ROUND,
} from "../../../../extensions/review-integration/tools/ask-round.ts";
import { askFunctions } from "./ask-source.ts";

/** Long enough past the last start that no spacing holds a round. */
const LONG_AGO_MS = 2 * 60 * 60_000;
/** How long a round may look before the test calls it held, under the test's own limit. */
const HELD_AFTER_MS = 3000;

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

const linePath = () => join(dirname(councilStartsPath()), "line.json");

/**
 * A line whose last start was long ago, with rounds of a live process
 * waiting ahead, as rounds held by this machine's memory wait.
 */
function heldLine(ids: readonly string[]): void {
	const now = Date.now();
	mkdirSync(dirname(linePath()), { recursive: true });
	writeFileSync(
		linePath(),
		JSON.stringify({
			started: {
				at: new Date(now - LONG_AGO_MS).toISOString(),
				by: "A2VLJN",
				change: "o/r#0",
			},
			waiting: ids.map((id, at) => ({
				id,
				by: id,
				change: `o/r#${id}`,
				pid: process.pid,
				askedAt: new Date(now - LONG_AGO_MS + at).toISOString(),
				seenAt: new Date(now).toISOString(),
			})),
		}),
	);
}

describe("a council whose reviewers run on a room", () => {
	it("starts past rounds this machine's bars hold, which keep their places", async () => {
		heldLine(["memory", "cpu"]);

		const start = await awaitRosterStart(
			"owner/repo#1",
			// any time: a bound on a wrong wait; a held round fails below.
			AbortSignal.timeout(HELD_AFTER_MS),
			"council",
			ROOM_ROUND,
		);

		expect(start.cancelled, "started, not held").toBeUndefined();
		const line = JSON.parse(readFileSync(linePath(), "utf8"));
		expect(line.started.change).toBe("owner/repo#1");
		expect(line.waiting.map((each: { id: string }) => each.id)).toEqual([
			"memory",
			"cpu",
		]);
		await start.release?.();
	});

	it("reads its room again after the wait, and waits on this machine's bars when it's gone", () => {
		const body = askFunctions().get("councilRound") ?? "";
		const started = body.indexOf("await awaitRosterStart(");
		const again = body.indexOf("await roomNow()", started);
		const local = body.indexOf("await awaitRosterStart(", again);

		expect(started, "councilRound takes a start").toBeGreaterThan(-1);
		expect(again, "and reads the room after it").toBeGreaterThan(started);
		expect(local, "then waits again on the bars here").toBeGreaterThan(again);
	});

	it("is the room both council rounds start their reviewers on", () => {
		const functions = askFunctions();
		for (const name of ["askCouncil", "startRound"]) {
			const body = functions.get(name) ?? "";
			expect(body, `${name} reads the room councilRound chose`).toMatch(
				/const \{[^}]*\broom\b[^}]*\} = set;/,
			);
			expect(body, `${name} doesn't decide a room of its own`).not.toContain(
				"roomFor(",
			);
		}
	});
});
