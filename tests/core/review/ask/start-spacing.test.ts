/**
 * The council start line: who starts when, who waits and in what order,
 * and what a waiting round is told.
 *
 * Long because every case drives the same real line on disk through
 * real waits, and its fixtures (a ticket's id drawn ahead, a read of
 * the line that fails once, a process that is gone) are shared by all
 * of them.
 */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	awaitCouncilStart,
	placesInLine,
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
/** How late a promise may settle after the start it answers. */
const SETTLED_LATE_MS = 50;
/** A process id nothing holds, for a ticket its process left behind. */
const GONE = 999_999_001;

/** The next ticket's id, when a test needs to know it before it is drawn. */
const nextTicket = vi.hoisted(() => ({ id: undefined as string | undefined }));

/** A read of the line to fail once, with this code, as the machine might. */
const readFault = vi.hoisted(() => ({ code: undefined as string | undefined }));

vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const readFile = (async (...args: Parameters<typeof fs.readFile>) => {
		const code = readFault.code;
		if (code !== undefined && String(args[0]).endsWith("line.json")) {
			readFault.code = undefined;
			throw Object.assign(new Error(`${code}: as the test asked`), { code });
		}
		return fs.readFile(...args);
	}) as typeof fs.readFile;
	return { ...fs, readFile };
});

vi.mock("node:crypto", async (original) => {
	const crypto = await original<typeof import("node:crypto")>();
	return {
		...crypto,
		randomUUID: () => {
			const id = nextTicket.id;
			nextTicket.id = undefined;
			return id ?? crypto.randomUUID();
		},
	};
});

let folder: string;
let path: string;

beforeEach(() => {
	// A fault a failed test left armed must not reach the next one.
	readFault.code = undefined;
	nextTicket.id = undefined;
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

	it("waits a spacing after the last start, saying it was next in line", async () => {
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
	it("starts rounds a spacing apart, in the order they joined, each saying whom it followed", async () => {
		const joined = ["A2VLJN", "ISXEG8", "85PKB2"];
		const starts: { by: string; at: number; waited?: string }[] = [];
		const rounds: Promise<void>[] = [];
		for (const [place, by] of joined.entries()) {
			rounds.push(
				awaitCouncilStart(path, claim(by)).then((start) => {
					starts.push({ by, at: Date.now(), waited: start.waited });
				}),
			);
			// Each joins once the one before it holds its place or has started.
			await expect
				.poll(() => starts.length + line().waiting.length, {
					timeout: 4_000,
					interval: 5,
				})
				.toBe(place + 1);
		}
		await Promise.all(rounds);

		expect(starts.map((each) => each.by)).toEqual(joined);
		for (const [place, each] of starts.entries()) {
			const before = starts[place - 1];
			if (before === undefined) continue;
			const gap = each.at - before.at;
			// Each start is read when its promise settles, which may come a
			// few milliseconds after the start itself on a loaded machine.
			expect(gap, `${each.by} a spacing after`).toBeGreaterThanOrEqual(
				SPACING - SETTLED_LATE_MS,
			);
			// The regression this guards: rounds waiting behind gaps, so
			// starts came several spacings apart. Loose, for a loaded machine.
			expect(gap, `${each.by} not held past its turn`).toBeLessThan(
				2 * SPACING,
			);
		}
		expect(starts[2]?.waited).toContain(
			"1 round ahead, behind o/r#ISXEG8 (asked by ISXEG8)",
		);
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
	// so its id, runs on; a busy lock keeps a live round from looking.
	// Either way it is passed over, and keeps its place while it lives.
	it("waits behind no round that has stopped looking, which keeps its place", async () => {
		const long = new Date(Date.now() - 10 * 60_000).toISOString();
		startedAt("A2VLJN", new Date(Date.now() - 2 * SPACING), [
			{
				id: "unseen",
				by: "ISXEG8",
				change: "o/r#unseen",
				pid: process.pid,
				askedAt: long,
				seenAt: long,
			},
		]);

		const start = await awaitCouncilStart(path, claim("85PKB2"));

		expect(start.waited, "it started at once").toBeUndefined();
		expect(line().waiting.map((each: { id: string }) => each.id)).toEqual([
			"unseen",
		]);
	});

	// 25 November: with sixty waiting, live tickets went unseen behind a
	// busy lock, were dropped, and joined again at the back.
	it("stands ahead again when a round passed over looks again", async () => {
		const long = new Date(Date.now() - 10 * 60_000).toISOString();
		const now = new Date().toISOString();
		startedAt("A2VLJN", new Date(), [
			{
				id: "later",
				by: "85PKB2",
				change: "o/r#later",
				pid: process.pid,
				askedAt: now,
				seenAt: now,
			},
			{
				id: "mine",
				by: "ISXEG8",
				change: "o/r#ISXEG8",
				pid: process.pid,
				askedAt: long,
				seenAt: long,
			},
		]);
		nextTicket.id = "mine";
		const giving = new AbortController();

		const waiting = awaitCouncilStart(
			path,
			claim("ISXEG8", { spacingMs: 60_000 }),
			giving.signal,
		);
		await expect
			.poll(() => line().waiting[0]?.id, { timeout: 4_000, interval: 10 })
			.toBe("mine");
		giving.abort();

		expect((await waiting).cancelled).toContain("next in line");
	});

	// A reader on the old rule drops a ticket it hasn't seen lately, and a
	// reload loses a round: either way the ask comes back as a new ticket.
	it("places a round asked again by when its change was first asked", async () => {
		const first = new Date(Date.now() - 30 * 60_000).toISOString();
		const now = new Date().toISOString();
		mkdirSync(join(folder, "starts"), { recursive: true });
		writeFileSync(
			linePath(),
			JSON.stringify({
				started: { at: now, by: "A2VLJN", change: "o/r#A2VLJN" },
				waiting: [
					{
						id: "later",
						by: "85PKB2",
						change: "o/r#later",
						pid: process.pid,
						askedAt: now,
						seenAt: now,
					},
				],
				firstAsked: { "o/r#ISXEG8": first },
			}),
		);
		const giving = new AbortController();

		const waiting = awaitCouncilStart(
			path,
			claim("ISXEG8", { spacingMs: 60_000 }),
			giving.signal,
		);
		await expect
			.poll(() => line().waiting[0]?.by, { timeout: 4_000, interval: 10 })
			.toBe("ISXEG8");
		const placed = line().waiting[0];
		giving.abort();
		await waiting;

		expect(placed.askedAt, "the first ask's time").toBe(first);
	});

	it("keeps urgent rounds first, then those that lead, then by first ask", async () => {
		const at = (minutes: number) =>
			new Date(Date.now() - minutes * 60_000).toISOString();
		const now = new Date().toISOString();
		const ticket = (id: string, askedAt: string, extra: object = {}) => ({
			id,
			by: id,
			change: `o/r#${id}`,
			pid: process.pid,
			askedAt,
			seenAt: now,
			...extra,
		});
		startedAt("A2VLJN", new Date(), [
			ticket("plain", at(30)),
			ticket("world", at(10), { change: "shop/world#1" }),
			ticket("marked", at(20), { leads: true }),
		]);
		const giving = new AbortController();

		const waiting = awaitCouncilStart(
			path,
			claim("ISXEG8", {
				spacingMs: 60_000,
				urgent: async () => ["o/r#ISXEG8"],
			}),
			giving.signal,
		);
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 10 })
			.toBe(4);
		const order = line().waiting.map((each: { by: string }) => each.by);
		giving.abort();
		await waiting;

		expect(order).toEqual(["ISXEG8", "marked", "world", "plain"]);
	});

	// 25 November: two rounds one session asked in the same millisecond
	// each saw the other ahead, so neither started, and every round behind
	// them waited, from 15:48 to 16:31 on a Mac and 18:54 to 19:16 here.
	it("starts both of two rounds first asked in the same millisecond", async () => {
		const asked = new Date(Date.now() - 60_000).toISOString();
		mkdirSync(join(folder, "starts"), { recursive: true });
		writeFileSync(
			linePath(),
			JSON.stringify({
				started: {
					at: new Date().toISOString(),
					by: "A2VLJN",
					change: "o/r#A2VLJN",
				},
				waiting: [],
				firstAsked: { "o/r#ISXEG8": asked, "o/r#85PKB2": asked },
			}),
		);
		const giving = new AbortController();
		const started: string[] = [];

		const rounds = ["ISXEG8", "85PKB2"].map((by) =>
			awaitCouncilStart(path, claim(by), giving.signal).then((start) => {
				if (start.cancelled === undefined) started.push(by);
			}),
		);
		// Two spacings and a wide margin for a loaded machine: without a tie
		// broken, neither ever starts, and with one, this waits no longer.
		const waited = setTimeout(() => giving.abort(), 10 * SPACING);
		await Promise.all(rounds);
		clearTimeout(waited);

		expect([...started].sort(), "both started").toEqual(["85PKB2", "ISXEG8"]);
	});

	it("starts both of two sessions' rounds on one change, which share its first ask", async () => {
		mkdirSync(join(folder, "starts"), { recursive: true });
		writeFileSync(
			linePath(),
			JSON.stringify({
				started: {
					at: new Date().toISOString(),
					by: "A2VLJN",
					change: "o/r#A2VLJN",
				},
				waiting: [],
				firstAsked: {
					"o/r#shared": new Date(Date.now() - 60_000).toISOString(),
				},
			}),
		);
		const giving = new AbortController();
		const started: string[] = [];

		const rounds = ["ISXEG8", "85PKB2"].map((by) =>
			awaitCouncilStart(
				path,
				claim(by, { change: "o/r#shared" }),
				giving.signal,
			).then((start) => {
				if (start.cancelled === undefined) started.push(by);
			}),
		);
		// As above: without a tie broken, neither ever starts.
		const waited = setTimeout(() => giving.abort(), 10 * SPACING);
		await Promise.all(rounds);
		clearTimeout(waited);

		expect([...started].sort(), "both started").toEqual(["85PKB2", "ISXEG8"]);
	});

	it("replaces an older ask of the session's for the change, keeping its place", async () => {
		const first = new Date(Date.now() - 30 * 60_000).toISOString();
		const now = new Date().toISOString();
		startedAt("A2VLJN", new Date(), [
			{
				id: "between",
				by: "85PKB2",
				change: "o/r#between",
				pid: process.pid,
				askedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
				seenAt: now,
			},
			{
				id: "older",
				by: "ISXEG8",
				change: "o/r#ISXEG8",
				pid: process.pid,
				askedAt: first,
				seenAt: now,
				kind: "council",
			},
		]);
		nextTicket.id = "newer";
		const giving = new AbortController();

		const waiting = awaitCouncilStart(
			path,
			claim("ISXEG8", { spacingMs: 60_000, kind: "council" }),
			giving.signal,
		);
		await expect
			.poll(() => line().waiting[0]?.id, { timeout: 4_000, interval: 10 })
			.toBe("newer");
		const kept = line();
		nextTicket.id = "older";
		const older = await awaitCouncilStart(path, claim("ISXEG8"));
		giving.abort();
		await waiting;

		expect(kept.waiting.map((each: { id: string }) => each.id)).toEqual([
			"newer",
			"between",
		]);
		expect(kept.waiting[0].askedAt, "the first ask's place").toBe(first);
		expect(older.cancelled).toContain("replaced by a newer ask");
		expect(older.release, "nothing started for it").toBeUndefined();
	});

	it("leaves a session's council waiting when it asks a critique of the change", async () => {
		const now = new Date().toISOString();
		startedAt("A2VLJN", new Date(), [
			{
				id: "council",
				by: "ISXEG8",
				change: "o/r#ISXEG8",
				pid: process.pid,
				askedAt: now,
				seenAt: now,
				kind: "council",
			},
		]);
		nextTicket.id = "critique";
		const giving = new AbortController();

		const waiting = awaitCouncilStart(
			path,
			claim("ISXEG8", { spacingMs: 60_000, kind: "critique" }),
			giving.signal,
		);
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 10 })
			.toBe(2);
		const kept = line();
		giving.abort();
		await waiting;

		expect(kept.waiting.map((each: { id: string }) => each.id)).toEqual([
			"council",
			"critique",
		]);
		expect(kept.replaced?.council, "the council not replaced").toBeUndefined();
	});

	it("puts a round its asker says leads ahead of earlier asks", async () => {
		const now = new Date().toISOString();
		startedAt("A2VLJN", new Date(), [
			{
				id: "plain",
				by: "85PKB2",
				change: "o/r#plain",
				pid: process.pid,
				askedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
				seenAt: now,
			},
		]);
		const giving = new AbortController();

		const waiting = awaitCouncilStart(
			path,
			claim("ISXEG8", { spacingMs: 60_000, leads: true }),
			giving.signal,
		);
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 10 })
			.toBe(2);
		const kept = line();
		giving.abort();
		await waiting;

		expect(kept.waiting.map((each: { by: string }) => each.by)).toEqual([
			"ISXEG8",
			"85PKB2",
		]);
		expect(kept.waiting[0].leads, "kept on its ticket").toBe(true);
	});

	it("forgets a change's first ask once it has started", async () => {
		const first = new Date(Date.now() - 30 * 60_000).toISOString();
		mkdirSync(join(folder, "starts"), { recursive: true });
		writeFileSync(
			linePath(),
			JSON.stringify({
				waiting: [],
				firstAsked: { "o/r#ISXEG8": first, "o/r#other": first },
			}),
		);

		await awaitCouncilStart(path, claim("ISXEG8"));

		expect(line().firstAsked?.["o/r#ISXEG8"]).toBeUndefined();
		expect(line().firstAsked?.["o/r#other"], "another's kept").toBe(first);
	});

	it("says where each round on a change stands, passing over those not looking", async () => {
		const long = new Date(Date.now() - 10 * 60_000).toISOString();
		const now = new Date().toISOString();
		const ticket = (id: string, change: string, seenAt: string) => ({
			id,
			by: id,
			change,
			pid: process.pid,
			askedAt: now,
			seenAt,
		});
		startedAt("A2VLJN", new Date(), [
			ticket("gone quiet", "o/r#1", long),
			ticket("first", "o/r#1", now),
			ticket("other", "o/r#2", now),
			ticket("second", "o/r#1", now),
		]);

		expect(await placesInLine(path, "o/r#1")).toEqual([
			{ position: 1, of: 3, by: "first", askedAt: now },
			{ position: 3, of: 3, by: "second", askedAt: now },
		]);
		expect(await placesInLine(path, "o/r#none")).toEqual([]);
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
			"1 round ahead, behind o/r#ahead (asked by ISXEG8), position 2 of 2 in the start line",
		);
	});

	it("leaves the line when given up while it waits, so the next isn't held behind it", async () => {
		startedAt("A2VLJN", new Date());
		const giving = new AbortController();
		// A spacing far longer than the poll, so the round is still waiting
		// when it is given up on a loaded machine.
		const waiting = awaitCouncilStart(
			path,
			claim("ISXEG8", { spacingMs: 60_000 }),
			giving.signal,
		);
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

	it("leaves a later start alone when an earlier round gives its start back", async () => {
		const start = await awaitCouncilStart(path, claim("ISXEG8"));
		const later = new Date(Date.now() + 1);
		startedAt("85PKB2", later);

		await start.release?.();

		expect(line().started.by, "the later start stands").toBe("85PKB2");
	});

	// A clock stepped back, or a line written by hand, would otherwise
	// hold every start for as long as the start lay ahead.
	it("spaces from no start that lies hours ahead", async () => {
		startedAt("A2VLJN", new Date(Date.now() + 3 * 60 * 60_000));

		const start = await awaitCouncilStart(path, claim("ISXEG8"));

		expect(start.waited, "it started at once").toBeUndefined();
		expect(line().started.by).toBe("ISXEG8");
	});

	it("waits behind no ticket seen in the future, even while its process lives", async () => {
		const ahead = new Date(Date.now() + 60 * 60_000).toISOString();
		startedAt("A2VLJN", new Date(Date.now() - 2 * SPACING), [
			{
				id: "future",
				by: "ISXEG8",
				change: "o/r#future",
				pid: process.pid,
				askedAt: ahead,
				seenAt: ahead,
			},
		]);

		const start = await awaitCouncilStart(path, claim("85PKB2"));

		expect(start.waited, "it started at once").toBeUndefined();
		expect(line().waiting).toEqual([]);
	});

	it("looks again after a look fails, rather than giving up its place", async () => {
		let looks = 0;
		const start = await awaitCouncilStart(
			path,
			claim("ISXEG8", {
				startedElsewhere: async () => {
					looks += 1;
					if (looks <= 2) throw new Error("lock held too long");
					return undefined;
				},
			}),
		);

		expect(line().started.by, "it started on the third look").toBe("ISXEG8");
		expect(start.cancelled).toBeUndefined();
	});

	// The first look is the one that joins, so a fault there must be
	// retried like any other rather than failing the round outright.
	it("joins on a later look when the first can't write the line", async () => {
		// A folder where the line goes fails the first look's write.
		mkdirSync(linePath(), { recursive: true });
		let looks = 0;

		const start = await awaitCouncilStart(
			path,
			claim("ISXEG8", {
				startedElsewhere: async () => {
					looks += 1;
					if (looks === 2) rmSync(linePath(), { recursive: true });
					return undefined;
				},
			}),
		);

		expect(looks, "the first look failed and was retried").toBe(2);
		expect(start.release).toBeDefined();
		expect(line().started.by).toBe("ISXEG8");
	});

	it("leaves the line and says why when every look after joining fails", async () => {
		startedAt("A2VLJN", new Date());
		let looks = 0;

		await expect(
			awaitCouncilStart(
				path,
				claim("ISXEG8", {
					spacingMs: 60_000,
					startedElsewhere: async () => {
						looks += 1;
						if (looks > 1) throw new Error("lock held too long");
						return undefined;
					},
				}),
			),
		).rejects.toThrow("lock held too long");

		expect(looks, "it joined, then four looks in a row failed").toBe(5);
		expect(line().waiting, "no ticket left holding the head").toEqual([]);
		expect(line().started.by, "the start before stands").toBe("A2VLJN");
	});

	// A look can take the start and then fail before it answers; the next
	// look finds the start its own, and a refusal must still give it back.
	it("gives back a start a failed look took, putting back the one before", async () => {
		const first = new Date(Date.now() - 2 * SPACING);
		const before = {
			at: first.toISOString(),
			by: "A2VLJN",
			change: "o/r#A2VLJN",
		};
		mkdirSync(join(folder, "starts"), { recursive: true });
		writeFileSync(
			linePath(),
			JSON.stringify({
				started: {
					at: new Date().toISOString(),
					by: "ISXEG8",
					change: "o/r#ISXEG8",
					ticket: "mine",
					follows: before,
				},
				waiting: [],
			}),
		);
		nextTicket.id = "mine";

		const start = await awaitCouncilStart(path, claim("ISXEG8"));
		await start.release?.();

		expect(line().started).toEqual(before);
	});

	// A quiet machine starts the next round one look after a start, so a
	// look that took one and failed may find another's start on top of it.
	it("is started when the start it took and lost track of was followed by another", async () => {
		mkdirSync(join(folder, "starts"), { recursive: true });
		const mine = {
			at: new Date(Date.now() - 20).toISOString(),
			by: "ISXEG8",
			change: "o/r#ISXEG8",
			ticket: "mine",
		};
		writeFileSync(
			linePath(),
			JSON.stringify({
				started: {
					at: new Date().toISOString(),
					by: "A2VLJN",
					change: "o/r#A2VLJN",
					ticket: "theirs",
					follows: mine,
				},
				waiting: [],
			}),
		);
		nextTicket.id = "mine";
		const giving = new AbortController();

		const waiting = awaitCouncilStart(
			path,
			claim("ISXEG8", { spacingMs: 60_000, lookAgainMs: 60_000 }),
			giving.signal,
		);
		const stopping = setTimeout(() => giving.abort(), 2_000);
		const start = await waiting;
		clearTimeout(stopping);

		expect(start.cancelled, "started, not owed another").toBeUndefined();
		await start.release?.();
		expect(line().started.ticket, "the later start stands").toBe("theirs");
		expect(line().waiting).toEqual([]);
	});

	it("gives back a start taken in its name when stopped before it looks again", async () => {
		const first = new Date();
		const before = {
			at: first.toISOString(),
			by: "A2VLJN",
			change: "o/r#A2VLJN",
		};
		startedAt("A2VLJN", first);
		nextTicket.id = "mine";
		const giving = new AbortController();
		// Long waits both ways, so the round sleeps through what follows.
		const waiting = awaitCouncilStart(
			path,
			claim("ISXEG8", { spacingMs: 60_000, lookAgainMs: 60_000 }),
			giving.signal,
		);
		await expect
			.poll(() => line().waiting.length, { timeout: 4_000, interval: 10 })
			.toBe(1);
		// What a look leaves when it took the start and failed on its way out.
		writeFileSync(
			linePath(),
			JSON.stringify({
				started: {
					at: new Date().toISOString(),
					by: "ISXEG8",
					change: "o/r#ISXEG8",
					ticket: "mine",
					follows: before,
				},
				// A look that takes the start drops its ticket from the line.
				waiting: [],
			}),
		);

		giving.abort();

		expect((await waiting).cancelled).toContain("stopped");
		expect(line().started).toEqual(before);
		expect(line().waiting).toEqual([]);
	});

	it("says the spacing in whole minutes, or else in seconds", async () => {
		for (const [spacingMs, said] of [
			[120_000, "each 2 minutes"],
			[60_000, "each minute"],
			[90_000, "each 90 seconds"],
		] as const) {
			startedAt("A2VLJN", new Date());
			const giving = new AbortController();
			const waiting = awaitCouncilStart(
				path,
				claim("ISXEG8", { spacingMs }),
				giving.signal,
			);
			await expect
				.poll(() => line().waiting.length, { timeout: 4_000, interval: 10 })
				.toBe(1);
			giving.abort();

			expect((await waiting).cancelled).toContain(said);
		}
	});

	// The line keeps its own floor, so no caller can make it loop tightly
	// or let a failed look lose its start, whatever spacing it asks for.
	it("spaces starts at least two looks apart, whatever it is asked", async () => {
		const first = new Date();
		startedAt("A2VLJN", first);

		await awaitCouncilStart(
			path,
			claim("ISXEG8", { spacingMs: 0, lookAgainMs: 150 }),
		);

		expect(Date.now()).toBeGreaterThanOrEqual(
			first.getTime() + 300 - TIMER_EARLY_MS,
		);
	});

	it("gives the start back when stopped during the look that took it", async () => {
		const giving = new AbortController();

		const start = await awaitCouncilStart(
			path,
			claim("ISXEG8", {
				startedElsewhere: async () => {
					giving.abort();
					return undefined;
				},
			}),
			giving.signal,
		);

		expect(start.cancelled).toContain("stopped");
		expect(start.release).toBeUndefined();
		expect(line().started, "nothing started in its name").toBeUndefined();
	});

	it("waits behind no ticket naming no single process", async () => {
		const now = new Date().toISOString();
		startedAt("A2VLJN", new Date(Date.now() - 2 * SPACING), [
			{
				id: "group",
				by: "ISXEG8",
				change: "o/r#group",
				pid: 0,
				askedAt: now,
				seenAt: now,
			},
		]);
		const { alive: _, ...bySignal } = claim("85PKB2");

		const start = await awaitCouncilStart(path, bySignal);

		expect(start.waited, "it started at once").toBeUndefined();
		expect(line().waiting).toEqual([]);
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

	// A garbled line lost its last start, so reading it as empty would let
	// the next round start with no spacing at all.
	it("spaces from now when the line is cut short, and writes it whole again", async () => {
		mkdirSync(join(folder, "starts"), { recursive: true });
		writeFileSync(linePath(), "{ cut short");
		const asked = Date.now();

		await awaitCouncilStart(path, claim("ISXEG8"));

		expect(Date.now()).toBeGreaterThanOrEqual(asked + SPACING - TIMER_EARLY_MS);
		expect(line().started.by).toBe("ISXEG8");
	});

	it("spaces from now when the line holds no waiting list or a bad start", async () => {
		for (const kept of ["{}", '{"started":{"at":"soon"},"waiting":[]}']) {
			mkdirSync(join(folder, "starts"), { recursive: true });
			writeFileSync(linePath(), kept);
			const asked = Date.now();

			await awaitCouncilStart(path, claim("ISXEG8"));

			expect(Date.now(), kept).toBeGreaterThanOrEqual(
				asked + SPACING - TIMER_EARLY_MS,
			);
		}
	});

	// A machine out of descriptors may read the line whole a moment later;
	// writing over it then would lose its waiters and its last start.
	it("looks again after a read that failed for the moment, keeping the line", async () => {
		startedAt("A2VLJN", new Date(Date.now() - SPACING / 2));
		readFault.code = "EMFILE";

		await awaitCouncilStart(path, claim("ISXEG8"));

		expect(readFault.code, "the fault was met").toBeUndefined();
		expect(line().started.by).toBe("ISXEG8");
		expect(line().started.follows.by, "spaced from the start kept").toBe(
			"A2VLJN",
		);
	});

	// An unreadable line used to fail every round on the machine.
	it("writes a whole line over one it can't read, spacing from now", async () => {
		mkdirSync(join(folder, "starts"), { recursive: true });
		// What a reader that can read it anyway, as root can, takes as garbled.
		writeFileSync(linePath(), "{}");
		chmodSync(linePath(), 0o000);
		const asked = Date.now();

		const start = await awaitCouncilStart(path, claim("ISXEG8"));

		expect(start.release).toBeDefined();
		expect(Date.now()).toBeGreaterThanOrEqual(asked + SPACING - TIMER_EARLY_MS);
		expect(line().started.by, "readable again").toBe("ISXEG8");
	});
});
