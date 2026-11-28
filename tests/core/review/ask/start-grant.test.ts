/**
 * A round grants the first in line its start when that round's ticket
 * doesn't say it judges its own, as one an older install wrote: its
 * code may hold it on a bar this round's reading passes (27 November,
 * 111 rounds behind a CPU bar #2427 had replaced).
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	awaitCouncilStart,
	type RoomHeld,
} from "../../../../lib/core/review/ask/start-spacing.ts";

/** How often a waiting round looks again in these tests. */
const LOOK = 10;
/** How long a round watches the line before it is stopped. */
const WATCHED = 20 * LOOK;

let folder: string;
let path: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "council-grant-"));
	path = join(folder, "starts", "last.json");
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const linePath = () => join(folder, "starts", "line.json");
const line = () => JSON.parse(readFileSync(linePath(), "utf8"));

/** A ticket first in line, asked a while ago and seen just now. */
const head = (extra: object = {}) => ({
	id: "older-round",
	by: "OLDER1",
	change: "o/r#older",
	pid: process.pid,
	askedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
	seenAt: new Date().toISOString(),
	...extra,
});

/** A line holding `waiting`, its last start long past. */
function lineWith(waiting: object[]): void {
	mkdirSync(join(folder, "starts"), { recursive: true });
	writeFileSync(
		linePath(),
		JSON.stringify({
			started: {
				at: new Date(Date.now() - 60 * 60_000).toISOString(),
				by: "EARLIER",
				change: "o/r#earlier",
			},
			waiting,
		}),
	);
}

/** A round that starts on room alone, short whenever `held` says so. */
const onRoom = (by: string, held: () => RoomHeld | undefined) => ({
	by,
	change: `o/r#${by}`,
	lookAgainMs: LOOK,
	alive: () => true,
	room: async () => held(),
});

const short: RoomHeld = {
	said: "CPU some avg60 was 46, at or past 40",
	readings: ["CPU some avg60"],
	passable: true,
};

/** Runs a round for {@link WATCHED} and stops it. */
async function watched(claim: ReturnType<typeof onRoom>): Promise<void> {
	const stop = new AbortController();
	const start = awaitCouncilStart(path, claim, stop.signal);
	await new Promise((done) => setTimeout(done, WATCHED));
	stop.abort();
	await start;
}

describe("a round behind a head that doesn't judge its own start", () => {
	it("grants it the start in its ticket's name when it finds room, then starts after it", async () => {
		lineWith([head()]);

		await awaitCouncilStart(
			path,
			onRoom("NEWER1", () => undefined),
		);

		const kept = line();
		expect(kept.started.by, "its own start came after").toBe("NEWER1");
		expect(kept.started.follows).toMatchObject({
			by: "OLDER1",
			change: "o/r#older",
			ticket: "older-round",
		});
		expect(kept.waiting, "the head left the line with its start").toEqual([]);
	});

	it("grants nothing while its own reading is short", async () => {
		lineWith([head()]);

		await watched(onRoom("NEWER1", () => short));

		const kept = line();
		expect(kept.started.by).toBe("EARLIER");
		expect(kept.waiting[0].id, "the head keeps its place").toBe("older-round");
	});

	it("grants nothing to a head not seen lately, and starts itself", async () => {
		lineWith([
			head({ seenAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
		]);

		await awaitCouncilStart(
			path,
			onRoom("NEWER1", () => undefined),
		);

		const kept = line();
		expect(kept.started.by).toBe("NEWER1");
		expect(kept.started.follows.by).toBe("EARLIER");
	});
});

describe("a round behind a head that judges its own start", () => {
	it("grants it nothing, leaving it first", async () => {
		lineWith([head({ judges: true })]);

		await watched(onRoom("NEWER1", () => undefined));

		const kept = line();
		expect(kept.started.by).toBe("EARLIER");
		expect(kept.waiting[0].id).toBe("older-round");
	});

	it("is how every round on this code joins", async () => {
		const stop = new AbortController();
		const start = awaitCouncilStart(
			path,
			onRoom("NEWER1", () => short),
			stop.signal,
		);
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 5 })
			.toBe(1);
		const joined = line().waiting[0];
		stop.abort();
		await start;

		expect(joined.judges).toBe(true);
	});
});
