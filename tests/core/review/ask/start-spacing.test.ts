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
import { newRunId } from "../../../../lib/core/review/ask/run.ts";
import {
	awaitCouncilStart,
	newestRosterStartIn,
} from "../../../../lib/core/review/ask/start-spacing.ts";

/**
 * A real wait's spacing: long enough that claims made together land
 * inside it on a loaded machine, short enough to keep the suite quick.
 */
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

describe("spacing council starts on one machine", () => {
	it("starts the first at once, saying nothing, and keeps its start for the next", async () => {
		const start = await awaitCouncilStart(path, claim("A2VLJN"));

		expect(start.waited).toBeUndefined();
		expect(start.cancelled).toBeUndefined();
		expect(line().started.by).toBe("A2VLJN");
		expect(line().waiting, "nobody left waiting").toEqual([]);
	});

	it("waits a spacing after the last start, saying its place and whom it followed", async () => {
		const first = new Date();
		startedAt("A2VLJN", first);

		const start = await awaitCouncilStart(path, claim("ISXEG8"));

		expect(Date.now(), "it waited a spacing").toBeGreaterThanOrEqual(
			first.getTime() + SPACING - TIMER_EARLY_MS,
		);
		expect(start.waited).toContain("next in line");
		expect(line().started.by).toBe("ISXEG8");
	});

	// 22 November, 03:44 to 04:00: starts every few minutes, because each
	// session read the mesh and saw no start before it made its own.
	it("starts rounds asked at once a spacing apart, in the order they joined", async () => {
		const asked = Date.now();
		const order: string[] = [];
		await Promise.all(
			["A2VLJN", "ISXEG8", "85PKB2"].map(async (by) => {
				await awaitCouncilStart(path, claim(by));
				order.push(by);
			}),
		);

		expect(order).toHaveLength(3);
		expect(
			Date.now() - asked,
			"three starts take two spacings",
		).toBeGreaterThanOrEqual(2 * SPACING - TIMER_EARLY_MS);
	});

	// 22 November: starts every three minutes until 01:12Z, then every
	// nine to thirteen, behind slots kept for rounds that never started.
	it("waits behind no round whose process is gone", async () => {
		startedAt("A2VLJN", new Date(Date.now() - 2 * SPACING), [
			{
				id: "left",
				by: "ISXEG8",
				change: "o/r#left",
				pid: GONE,
				askedAt: new Date().toISOString(),
				seenAt: new Date().toISOString(),
			},
		]);

		const start = await awaitCouncilStart(path, claim("85PKB2"));

		expect(start.waited, "it started at once").toBeUndefined();
		expect(line().waiting, "the ticket left behind is dropped").toEqual([]);
	});

	// A reload abandons a waiting round while the session's process, and
	// so its id, runs on.
	it("waits behind no round that has stopped looking at the line", async () => {
		const long = new Date(Date.now() - 10 * 60_000).toISOString();
		startedAt("A2VLJN", new Date(Date.now() - 2 * SPACING), [
			{
				id: "abandoned",
				by: "ISXEG8",
				change: "o/r#abandoned",
				pid: process.pid,
				askedAt: long,
				seenAt: long,
			},
		]);

		const start = await awaitCouncilStart(path, claim("85PKB2"));

		expect(start.waited, "it started at once").toBeUndefined();
		expect(line().waiting).toEqual([]);
	});

	it("waits behind a round still looking, and says whose", async () => {
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
		const giving = new AbortController();

		const waiting = awaitCouncilStart(path, claim("85PKB2"), giving.signal);
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 10 })
			.toBe(2);
		giving.abort();

		expect((await waiting).cancelled).toContain(
			"1 round ahead, behind o/r#ahead (asked by ISXEG8)",
		);
	});

	it("leaves the line when given up while it waits, so the next isn't held behind it", async () => {
		startedAt("A2VLJN", new Date());
		const giving = new AbortController();
		const waiting = awaitCouncilStart(path, claim("ISXEG8"), giving.signal);
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 10 })
			.toBe(1);

		giving.abort();

		const start = await waiting;
		expect(start.cancelled).toContain("stopped while it waited");
		expect(start.waited).toBeUndefined();
		expect(line().waiting).toEqual([]);
		expect(line().started.by, "nothing started in its name").toBe("A2VLJN");
	});

	it("puts back the start before it when the round is refused once its wait is over", async () => {
		const first = new Date(Date.now() - 2 * SPACING);
		startedAt("A2VLJN", first);
		const start = await awaitCouncilStart(path, claim("ISXEG8"));
		expect(line().started.by).toBe("ISXEG8");

		await start.release?.();

		expect(line().started).toEqual({
			at: first.toISOString(),
			by: "A2VLJN",
			change: "o/r#A2VLJN",
		});
	});

	it("takes no place when stopped before it asks", async () => {
		const giving = new AbortController();
		giving.abort();

		const start = await awaitCouncilStart(path, claim("ISXEG8"), giving.signal);

		expect(start.cancelled).toContain("stopped");
		expect(() => line(), "nothing kept").toThrow();
	});

	it("spaces from a round started outside the line", async () => {
		const elsewhere = new Date();

		await awaitCouncilStart(
			path,
			claim("ISXEG8", { startedElsewhere: async () => elsewhere }),
		);

		expect(Date.now()).toBeGreaterThanOrEqual(
			elsewhere.getTime() + SPACING - TIMER_EARLY_MS,
		);
	});

	it("counts an older install's slot once it has come, and waits behind none still to come", async () => {
		mkdirSync(join(folder, "starts"), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
				by: "old",
				change: "o/r#old",
			}),
		);
		const ahead = await awaitCouncilStart(path, claim("ISXEG8"));
		expect(ahead.waited, "a slot an hour off holds nobody").toBeUndefined();

		rmSync(linePath());
		const come = new Date();
		writeFileSync(
			path,
			JSON.stringify({
				startAt: come.toISOString(),
				by: "old",
				change: "o/r#old",
			}),
		);
		await awaitCouncilStart(path, claim("85PKB2"));
		expect(
			Date.now(),
			"a slot that has come is a start",
		).toBeGreaterThanOrEqual(come.getTime() + SPACING - TIMER_EARLY_MS);
	});

	it("reads a line cut short as nobody waiting", async () => {
		mkdirSync(join(folder, "starts"), { recursive: true });
		writeFileSync(linePath(), "{ cut short");

		const start = await awaitCouncilStart(path, claim("ISXEG8"));

		expect(start.waited).toBeUndefined();
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
