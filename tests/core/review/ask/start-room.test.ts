/**
 * Council starts on room alone, a line whose lock is busy, and the
 * newest roster start the transcripts hold. The spacing a configured
 * wait keeps, and the line's own upkeep, are in start-spacing.test.ts.
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
import { newRunId } from "../../../../lib/core/review/ask/run.ts";
import {
	awaitCouncilStart,
	newestRosterStartIn,
} from "../../../../lib/core/review/ask/start-spacing.ts";

/** A spacing no start on room should wait for. */
const SPACING = 600;
/** How often a waiting round looks again in these tests. */
const LOOK = 10;
/** How early a Node timer may fire against `Date.now()`. */
const TIMER_EARLY_MS = 2;
/** A process id nothing holds, for a ticket its process left behind. */
const GONE = 999_999_001;

let folder: string;
let path: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "council-starts-"));
	path = join(folder, "starts", "last.json");
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const linePath = () => join(folder, "starts", "line.json");
/**
 * The line's file and when it was last changed, to the nanosecond: a
 * write lands by a rename, which a reused inode number alone could hide.
 */
const written = () => {
	const seen = statSync(linePath(), { bigint: true });
	return `${seen.ino}@${seen.mtimeNs}`;
};
const line = () => JSON.parse(readFileSync(linePath(), "utf8"));
const claim = (by: string, extra: object = {}) => ({
	by,
	change: `o/r#${by}`,
	spacingMs: SPACING,
	lookAgainMs: LOOK,
	alive: (pid: number) => pid !== GONE,
	...extra,
});

/** A line with `by` started at `at`, as another session left it. */
function startedAt(by: string, at: Date, waiting: object[] = []): void {
	mkdirSync(join(folder, "starts"), { recursive: true });
	writeFileSync(
		linePath(),
		JSON.stringify({
			started: { at: at.toISOString(), by, change: `o/r#${by}` },
			waiting,
		}),
	);
}

/** A claim that starts on room alone, with no spacing asked for. */
const onRoom = (by: string, room: () => Promise<string | undefined>) =>
	claim(by, { spacingMs: undefined, room });
const roomy = async (): Promise<string | undefined> => undefined;

// 24 November: a round waited about 30 minutes behind ten others, three
// minutes apart, on a machine with memory for all of them.
describe("starting council rounds on room alone", () => {
	it("starts two looks after another round's start when the machine has room, not a spacing", async () => {
		const before = new Date();
		startedAt("A2VLJN", before);

		await awaitCouncilStart(path, onRoom("ISXEG8", roomy));

		const gap = Date.now() - before.getTime();
		expect(gap, "the floor held it").toBeGreaterThanOrEqual(
			2 * LOOK - TIMER_EARLY_MS,
		);
		expect(gap, "no spacing held it").toBeLessThan(SPACING);
		expect(line().started.by).toBe("ISXEG8");
	});

	it("starts one look after another round's start, not its spacing, while the machine is quiet", async () => {
		const before = new Date();
		startedAt("A2VLJN", before);

		// Looks long enough apart that one look and two can be told apart.
		const look = 500;

		const start = await awaitCouncilStart(
			path,
			claim("ISXEG8", {
				spacingMs: 10 * look,
				lookAgainMs: look,
				room: roomy,
				quiet: async () => true,
			}),
		);

		const gap = Date.now() - before.getTime();
		expect(gap, "the floor held it").toBeGreaterThanOrEqual(
			look - TIMER_EARLY_MS,
		);
		expect(gap, "not two looks").toBeLessThan(1.8 * look);
		expect(start.waited).toMatch(/, or each .+ while it is quiet,/);
	});

	it("goes by the spacing as configured at each look, not as it was when asked", async () => {
		const before = new Date();
		startedAt("A2VLJN", before);
		let looks = 0;
		// Ten minutes when asked; the config is then set to its floor.
		const spacing = async () => {
			looks += 1;
			return looks <= 2 ? 600_000 : 0;
		};

		await awaitCouncilStart(
			path,
			claim("ISXEG8", { spacingMs: undefined, room: roomy, spacing }),
		);

		expect(looks, "it looked again").toBeGreaterThan(2);
		expect(Date.now() - before.getTime()).toBeLessThan(SPACING);
	});

	it("keeps its spacing when the machine isn't quiet", async () => {
		const before = new Date();
		startedAt("A2VLJN", before);

		await awaitCouncilStart(
			path,
			claim("ISXEG8", { room: roomy, quiet: async () => false }),
		);

		expect(Date.now() - before.getTime()).toBeGreaterThanOrEqual(
			SPACING - TIMER_EARLY_MS,
		);
	});

	it("waits while the machine is short, then starts, saying what it was short of", async () => {
		let looks = 0;
		const room = async () => {
			looks += 1;
			return looks <= 3
				? "memory full avg60 was 14, at or past 5; CPU some avg60 was 46, at or past 40"
				: undefined;
		};

		const start = await awaitCouncilStart(path, onRoom("ISXEG8", room));

		expect(looks, "it looked until there was room").toBe(4);
		expect(start.waited).toContain("while the machine has room");
		expect(start.waited).toContain("memory full avg60 was 14");
		expect(line().started.by).toBe("ISXEG8");
	});

	it("keeps a round short of room in line, so the one behind it waits its turn", async () => {
		let short = true;
		const room = async () => (short ? "memory full avg60 was 12" : undefined);
		const first = awaitCouncilStart(path, onRoom("A2VLJN", room));
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 5 })
			.toBe(1);
		const second = awaitCouncilStart(path, onRoom("ISXEG8", roomy));
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 5 })
			.toBe(2);

		short = false;
		const order: string[] = [];
		await Promise.all([
			first.then(() => order.push("A2VLJN")),
			second.then(() => order.push("ISXEG8")),
		]);

		expect(order, "in the order they were asked").toEqual(["A2VLJN", "ISXEG8"]);
	});

	it("starts rounds in the order asked, two looks apart rather than a spacing", async () => {
		const joined = ["A2VLJN", "ISXEG8", "85PKB2"];
		const order: string[] = [];
		const rounds: Promise<void>[] = [];
		const asked = Date.now();
		for (const [place, by] of joined.entries()) {
			rounds.push(
				awaitCouncilStart(path, onRoom(by, roomy)).then(() => {
					order.push(by);
				}),
			);
			// Each joins once the one before it holds its place or has started.
			await expect
				.poll(() => order.length + line().waiting.length, {
					timeout: 4_000,
					interval: 1,
				})
				.toBeGreaterThanOrEqual(place + 1);
		}
		await Promise.all(rounds);

		expect(order, "in the order they were asked").toEqual(joined);
		const took = Date.now() - asked;
		expect(took, "two floors between three starts").toBeGreaterThanOrEqual(
			2 * 2 * LOOK - TIMER_EARLY_MS,
		);
		expect(took, "all three inside one spacing").toBeLessThan(SPACING);
	});

	// The council of 25 November: with a spacing set, a round short of
	// memory whose spacing had passed looked again every millisecond.
	it("looks again at the usual pace while short, whatever its spacing", async () => {
		let looks = 0;
		const stop = new AbortController();
		const start = awaitCouncilStart(
			path,
			claim("ISXEG8", {
				room: async () => {
					looks += 1;
					return "memory full avg60 was 12";
				},
			}),
			stop.signal,
		);
		const watched = 20 * LOOK;
		// Long enough for twenty looks at the usual pace, against hundreds
		// at one a millisecond.
		await new Promise((done) => setTimeout(done, watched));
		stop.abort();
		await start;

		expect(looks, "about one a look").toBeLessThanOrEqual(watched / LOOK + 5);
	});

	it("says the rule it waited under when stopped", async () => {
		const stop = new AbortController();
		const start = awaitCouncilStart(
			path,
			onRoom("ISXEG8", async () => "memory full avg60 was 20"),
			stop.signal,
		);
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 5 })
			.toBe(1);
		stop.abort();

		const stopped = await start;
		expect(stopped.cancelled).toContain("while the machine has room");
		expect(stopped.cancelled, "and what it was short of").toContain(
			"memory full avg60 was 20",
		);
		expect(line().waiting, "its place given up").toEqual([]);
	});
});

// 24 November: a round lost a 42-minute place to a lock other waiters
// held past its wait, with 67 in line.
describe("a busy line's lock", () => {
	it("keeps looking past a lock held too long, however many times", async () => {
		let looks = 0;
		const start = await awaitCouncilStart(
			path,
			claim("ISXEG8", {
				startedElsewhere: async () => {
					looks += 1;
					if (looks <= 6) {
						throw Object.assign(new Error("line.json.lock has been held"), {
							code: "ELOCKHELD",
						});
					}
					return undefined;
				},
			}),
		);

		expect(looks, "past the four failures a broken line gets").toBe(7);
		expect(start.cancelled).toBeUndefined();
		expect(line().started.by).toBe("ISXEG8");
	});

	// 25 November, A2VLJN: seventy rounds each rewriting the line every
	// look, only to refresh when they were seen, kept its lock changing hands.
	it("leaves the line unwritten by a look that changes nothing in it", async () => {
		const now = new Date().toISOString();
		startedAt("A2VLJN", new Date(Date.now() - 2 * SPACING), [
			{
				id: "ahead",
				by: "ISXEG8",
				change: "o/r#ahead",
				pid: process.pid,
				askedAt: now,
				seenAt: now,
			},
		]);
		let looks = 0;
		const giving = new AbortController();

		const waiting = awaitCouncilStart(
			path,
			claim("85PKB2", {
				startedElsewhere: async () => {
					looks += 1;
					return undefined;
				},
			}),
			giving.signal,
		);
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 5 })
			.toBe(2);
		// Every write lands by a rename, so a new file is a write, even of
		// the same words.
		const joined = written();
		const joinedAt = looks;
		await expect
			.poll(() => looks, { timeout: 4_000, interval: 5 })
			.toBeGreaterThanOrEqual(joinedAt + 3);
		const later = written();
		giving.abort();
		await waiting;

		expect(later, "three looks later, the line is as it joined").toBe(joined);
	});
});

describe("the newest roster round in the transcripts", () => {
	it("reads the newest council, stack or critique, passing over judges and audits", async () => {
		const runs = join(folder, "runs");
		// Named as rounds name their folders, so a drift there shows here.
		for (const name of [
			newRunId("council", new Date("2026-11-22T17:41:17.298Z"), 2),
			newRunId("stack", new Date("2026-11-22T17:43:00.000Z"), 1),
			newRunId("judge", new Date("2026-11-22T17:50:00.000Z"), 1),
			newRunId("audit", new Date("2026-11-22T17:51:00.000Z"), 1),
			"notes",
		]) {
			mkdirSync(join(runs, name), { recursive: true });
		}

		expect(await newestRosterStartIn(runs)).toEqual(
			new Date("2026-11-22T17:43:00.000Z"),
		);
		expect(
			await newestRosterStartIn(join(folder, "none")),
			"no folder, no start",
		).toBeUndefined();
	});
});
