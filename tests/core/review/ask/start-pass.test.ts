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
	statSync,
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
		expect(start.waited).toContain(
			"It started past the machine's bar on CPU some avg60, which alone had held the line for under a minute",
		);
	});

	it("never lets a round past memory, however long it holds", async () => {
		const stop = new AbortController();
		const start = awaitCouncilStart(
			path,
			held("ISXEG8", async () => onMemory),
			stop.signal,
		);
		// A fixed wait, since what is tested is that nothing happens in it:
		// three whole holds, any one of which would pass a CPU bar.
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
		// Memory holds until a look has seen it, however slow the looks.
		const asked = Date.now();
		let memoryLooks = 0;
		let memoryLetGo: number | undefined;
		const room = async () => {
			const since = Date.now() - asked;
			if (since < AFTER / 2) return onCpu;
			if (since < AFTER || memoryLooks === 0) {
				memoryLooks += 1;
				return onMemory;
			}
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

	// Its second council: a look short on memory still carries the count
	// the looks before it left, and only its own reading keeps it held.
	it("holds a round whose CPU hold ran its length once memory is short", async () => {
		const last = Date.now();
		startedAt(new Date(last));
		let memoryLooks = 0;
		let memoryLetGo: number | undefined;
		// CPU alone past a whole hold, while the pass's spacing still holds
		// it. The first look short on memory is read slowly, so it lands
		// once the spacing has passed with the CPU count still running,
		// and memory holds a while after it; then CPU alone again.
		const room = async () => {
			const since = Date.now() - last;
			if (memoryLooks === 0 && since < SINCE - 4 * LOOK) return onCpu;
			if (memoryLooks === 0) {
				// A slow reading, as /proc can be under load: it ends past the
				// spacing, which is what this look has to meet.
				await new Promise((done) => setTimeout(done, 6 * LOOK));
			}
			if (memoryLooks === 0 || since < SINCE + AFTER / 2) {
				memoryLooks += 1;
				return onMemory;
			}
			memoryLetGo ??= Date.now();
			return onCpu;
		};

		await awaitCouncilStart(path, held("ISXEG8", room));

		expect(memoryLetGo, "memory held it past the spacing").toBeDefined();
		expect(
			Date.now() - (memoryLetGo ?? 0),
			"a whole hold after memory let go",
		).toBeGreaterThanOrEqual(AFTER - TIMER_EARLY_MS);
	});

	it("starts at once when the machine has room", async () => {
		const start = await awaitCouncilStart(
			path,
			held("ISXEG8", async () => undefined),
		);

		expect(start.waited).toBeUndefined();
		expect(line().started.by).toBe("ISXEG8");
	});

	it("says nothing of a pass for a round CPU held a while that started on room", async () => {
		let looks = 0;
		const room = async () => {
			looks += 1;
			return looks < 4 ? onCpu : undefined;
		};

		const start = await awaitCouncilStart(path, held("ISXEG8", room));

		expect(start.waited, "it waited").toContain("CPU some avg60 was 46");
		expect(start.waited).not.toContain("started past");
		expect(line().started.passed, "no pass kept").toBeUndefined();
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

	it("takes the hold off the line once the machine has room", async () => {
		let looks = 0;
		let heldBy: unknown;
		const room = async () => {
			looks += 1;
			if (looks < 4) return onMemory;
			heldBy ??= line().heldBy;
			return undefined;
		};

		await awaitCouncilStart(path, held("ISXEG8", room));

		expect(heldBy, "memory held it first").toEqual(["memory full avg60"]);
		expect(line().heldBy).toBeUndefined();
	});
});

/** A line holding `waiting`, with whatever else `rest` gives it. */
function lineOf(waiting: object[], rest: object = {}): void {
	mkdirSync(join(folder, "starts"), { recursive: true });
	writeFileSync(linePath(), JSON.stringify({ waiting, ...rest }));
}

/** A ticket written by hand, looking now, asked a while before. */
const handTicket = (id: string, extra: object = {}) => ({
	id,
	by: id,
	change: `o/r#${id}`,
	pid: process.pid,
	askedAt: new Date(Date.now() - 60_000).toISOString(),
	seenAt: new Date().toISOString(),
	...extra,
});

/** Where the line's file stands, so a write can be told from none. */
const written = () => {
	const seen = statSync(linePath(), { bigint: true });
	return `${seen.ino}@${seen.mtimeNs}`;
};

// #2312's round 2: each round counted the hold from its own first
// look, and any round's reading wrote the line's hold.
describe("keeping the hold by the line's clock", () => {
	it("lets one round past the bar each pass spacing, however many it holds", async () => {
		await Promise.all([
			awaitCouncilStart(
				path,
				held("ISXEG8", async () => onCpu),
			),
			awaitCouncilStart(
				path,
				held("A2VLJN", async () => onCpu),
			),
		]);

		const { started } = line();
		expect(
			Date.parse(started.at) - Date.parse(started.follows.at),
			"the pass's spacing between the two",
		).toBeGreaterThanOrEqual(SINCE - TIMER_EARLY_MS);
	});

	it("lets no round past a bar while the round ahead of it is held by memory", async () => {
		const stop = new AbortController();
		const head = awaitCouncilStart(
			path,
			held("A2VLJN", async () => onMemory),
			stop.signal,
		);
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 5 })
			.toBe(1);
		const behind = awaitCouncilStart(
			path,
			held("ISXEG8", async () => onCpu),
			stop.signal,
		);
		// A fixed wait, since what is tested is that nothing happens in it.
		await new Promise((done) => setTimeout(done, 3 * AFTER));
		stop.abort();
		await Promise.all([head, behind]);

		expect(line().started, "nothing started").toBeUndefined();
	});

	it("counts the hold from when it began for a round that moves up a held line", async () => {
		const after = 600;
		const since = 900;
		const urgent: string[] = [];
		const round = (by: string) => ({
			...held(by, async () => onCpu),
			pass: { afterMs: after, spacingMs: since },
			urgent: async () => urgent,
		});
		const t0 = Date.now();
		startedAt(new Date(t0));
		const stop = new AbortController();
		const first = awaitCouncilStart(path, round("A2VLJN"), stop.signal);
		await new Promise((done) => setTimeout(done, after + 100));
		urgent.push("o/r#ISXEG8");
		const joined = Date.now();

		await awaitCouncilStart(path, round("ISXEG8"));
		const startedAfter = Date.now() - joined;
		stop.abort();
		await first;

		expect(line().started.by).toBe("ISXEG8");
		expect(
			startedAfter,
			"it passed on the line's hold, not one of its own",
		).toBeLessThan(after);
	});

	it("passes a round ahead from an older install, which can't pass", async () => {
		lineOf([handTicket("OLDER1")]);
		const stop = new AbortController();
		const timer = setTimeout(() => stop.abort(), 3_000);

		const start = await awaitCouncilStart(
			path,
			held("ISXEG8", async () => onCpu),
			stop.signal,
		);
		clearTimeout(timer);

		expect(start.cancelled, "it was never stopped").toBeUndefined();
		expect(line().started.by).toBe("ISXEG8");
		expect(line().waiting.map((each: { id: string }) => each.id)).toEqual([
			"OLDER1",
		]);
	});

	it("keeps the line's hold behind a round from an older install, and takes it off", async () => {
		lineOf([handTicket("OLDER1")]);
		let looks = 0;
		const room = async () => {
			looks += 1;
			return looks < 4 ? onMemory : undefined;
		};
		const stop = new AbortController();
		const start = awaitCouncilStart(path, held("ISXEG8", room), stop.signal);

		await expect
			.poll(() => line().heldBy, { timeout: 4_000, interval: 2 })
			.toEqual(["memory full avg60"]);
		await expect
			.poll(() => line().heldBy, { timeout: 4_000, interval: 5 })
			.toBeUndefined();
		const [place] = await placesInLine(path, "o/r#ISXEG8");
		stop.abort();
		await start;

		expect(place, "still waiting").toEqual(
			expect.objectContaining({ position: 2 }),
		);
		expect(place?.heldBy, "no hold said").toBeUndefined();
	});

	it("leaves the line's hold to the round ahead that keeps it", async () => {
		lineOf([handTicket("AHEAD1", { passes: true })], {
			heldBy: ["CPU some avg60"],
			heldSince: new Date().toISOString(),
		});
		let looks = 0;
		const room = async () => {
			looks += 1;
			return looks % 2 === 0 ? onMemory : undefined;
		};
		const stop = new AbortController();
		const start = awaitCouncilStart(path, held("ISXEG8", room), stop.signal);
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 5 })
			.toBe(2);
		const joined = written();
		const looked = looks;

		await expect
			.poll(() => looks - looked, { timeout: 4_000, interval: 5 })
			.toBeGreaterThan(10);
		const after = written();
		stop.abort();
		await start;

		expect(after, "its looks wrote nothing").toBe(joined);
	});

	it("counts nothing from a hold no round still looks at", async () => {
		const gone = new Date(Date.now() - 5 * 60_000).toISOString();
		lineOf([handTicket("AHEAD1", { passes: true, seenAt: gone })], {
			heldBy: ["CPU some avg60"],
			heldSince: new Date(Date.now() - 30 * 60_000).toISOString(),
		});
		const stop = new AbortController();
		const start = awaitCouncilStart(
			path,
			{
				...held("ISXEG8", async () => onCpu),
				pass: { afterMs: 20 * 60_000, spacingMs: 10 * 60_000 },
			},
			stop.signal,
		);
		// A fixed wait, since what is tested is that nothing happens in it.
		await new Promise((done) => setTimeout(done, 10 * LOOK));
		stop.abort();
		await start;

		expect(line().started, "nothing started").toBeUndefined();
	});

	it("says how long the line was held for a round that passes at its first look", async () => {
		lineOf([handTicket("AHEAD1", { passes: true })], {
			heldBy: ["CPU some avg60"],
			heldSince: new Date(Date.now() - 30 * 60_000).toISOString(),
		});
		const stop = new AbortController();
		const timer = setTimeout(() => stop.abort(), 3_000);

		const start = await awaitCouncilStart(
			path,
			{
				by: "ISXEG8",
				change: "shop/world#1",
				lookAgainMs: LOOK,
				alive: () => true,
				room: async () => onCpu,
				leads: true,
			},
			stop.signal,
		);
		clearTimeout(timer);

		expect(start.waited).toContain(
			"It started past the machine's bar on CPU some avg60, which alone had held the line for about 30 minutes, since a round such a bar alone holds for 20 minutes starts once no round has started for 10 minutes.",
		);
	});
});
