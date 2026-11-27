/**
 * Council starts past a bar that has held too long: a round held by
 * CPU alone starts anyway once it has been held a while and no round
 * has started for a while, memory never lets one past, and the line
 * says what holds it.
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
	placesInLine,
	type RoomHeld,
} from "../../../../lib/core/review/ask/start-spacing.ts";

/** How often a waiting round looks again in these tests. */
const LOOK = 10;
/** How long a passable bar may hold a round in these tests. */
const AFTER = 150;
/** How long since the last start a passing round waits in these tests. */
const SINCE = 300;
/** How early a Node timer may fire against `Date.now()`. */
const TIMER_EARLY_MS = 2;

let folder: string;
let path: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "council-pass-"));
	path = join(folder, "starts", "last.json");
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const linePath = () => join(folder, "starts", "line.json");
const line = () => JSON.parse(readFileSync(linePath(), "utf8"));

const onCpu: RoomHeld = {
	said: "CPU some avg60 was 46, at or past 40",
	readings: ["CPU some avg60"],
	passable: true,
};
const onMemory: RoomHeld = {
	said: "memory full avg60 was 12, at or past 5",
	readings: ["memory full avg60"],
	passable: false,
};

/** A round on room alone, held by whatever `room` answers. */
const held = (by: string, room: () => Promise<RoomHeld | undefined>) => ({
	by,
	change: `o/r#${by}`,
	lookAgainMs: LOOK,
	alive: () => true,
	room,
	pass: { afterMs: AFTER, spacingMs: SINCE },
});

/** A line with a round started at `at` by another session. */
function startedAt(at: Date): void {
	mkdirSync(join(folder, "starts"), { recursive: true });
	writeFileSync(
		linePath(),
		JSON.stringify({
			started: { at: at.toISOString(), by: "A2VLJN", change: "o/r#A2VLJN" },
			waiting: [],
		}),
	);
}

// A210E4CA, 26 November: optimus sat at CPU some 40 to 54 from 17:45,
// so every round held by the CPU bar alone would have waited for hours.
describe("starting past a bar that has held too long", () => {
	it("starts a round held by CPU alone once it has been held long enough", async () => {
		const asked = Date.now();

		const start = await awaitCouncilStart(
			path,
			held("ISXEG8", async () => onCpu),
		);

		expect(Date.now() - asked, "it was held first").toBeGreaterThanOrEqual(
			AFTER - TIMER_EARLY_MS,
		);
		expect(line().started.by).toBe("ISXEG8");
		expect(start.waited).toContain("CPU some avg60 was 46");
		expect(start.waited).toContain("It started past the CPU bar");
	});

	it("never lets a round past memory, however long it holds", async () => {
		const stop = new AbortController();
		const start = awaitCouncilStart(
			path,
			held("ISXEG8", async () => onMemory),
			stop.signal,
		);
		await new Promise((done) => setTimeout(done, 3 * AFTER));
		stop.abort();

		const stopped = await start;
		expect(stopped.cancelled, "it never started").toContain("stopped");
		expect(line().started, "nothing started").toBeUndefined();
	});

	it("waits until no round has started for a while before passing", async () => {
		const before = new Date();
		startedAt(before);

		await awaitCouncilStart(
			path,
			held("ISXEG8", async () => onCpu),
		);

		expect(
			Date.now() - before.getTime(),
			"the pass's spacing since the last start",
		).toBeGreaterThanOrEqual(SINCE - TIMER_EARLY_MS);
		expect(line().started.by).toBe("ISXEG8");
	});

	it("counts the hold again from when memory let go", async () => {
		// By the clock, not by looks, so a slow machine's looks can't let
		// the first CPU hold run its whole length.
		const asked = Date.now();
		let memoryLetGo: number | undefined;
		const room = async () => {
			const since = Date.now() - asked;
			if (since < AFTER / 2) return onCpu;
			if (since < AFTER) return onMemory;
			memoryLetGo ??= Date.now();
			return onCpu;
		};

		await awaitCouncilStart(path, held("ISXEG8", room));

		expect(memoryLetGo, "memory held it a while").toBeDefined();
		expect(
			Date.now() - (memoryLetGo ?? 0),
			"a whole hold after memory let go",
		).toBeGreaterThanOrEqual(AFTER - TIMER_EARLY_MS);
	});

	it("starts at once when the machine has room, with nothing said of a pass", async () => {
		const start = await awaitCouncilStart(
			path,
			held("ISXEG8", async () => undefined),
		);

		expect(start.waited).toBeUndefined();
		expect(line().started.by).toBe("ISXEG8");
	});
});

// The council of 26 November: while a round was held, nothing it could
// be asked said which reading held it.
describe("the line saying what holds it", () => {
	it("keeps the readings that hold the machine, and a place says them", async () => {
		const stop = new AbortController();
		const start = awaitCouncilStart(
			path,
			held("ISXEG8", async () => onMemory),
			stop.signal,
		);
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 5 })
			.toBe(1);

		expect(line().heldBy).toEqual(["memory full avg60"]);
		expect(await placesInLine(path, "o/r#ISXEG8")).toEqual([
			expect.objectContaining({ position: 1, heldBy: ["memory full avg60"] }),
		]);
		stop.abort();
		await start;
	});

	it("leaves the hold off the line once the machine has room", async () => {
		await awaitCouncilStart(
			path,
			held("ISXEG8", async () => undefined),
		);

		expect(line().heldBy).toBeUndefined();
	});
});
