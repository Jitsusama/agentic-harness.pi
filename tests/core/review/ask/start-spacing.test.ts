import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** A claim that starts on room alone, with no spacing asked for. */
const onRoom = (by: string, room: () => Promise<string | undefined>) =>
	claim(by, { spacingMs: undefined, room });
const roomy = async (): Promise<string | undefined> => undefined;

// 24 November: a round waited about 30 minutes behind ten others, three
// minutes apart, on a machine with memory for all of them.
describe("starting council rounds on room alone", () => {
	it("starts at once after another round's start when the machine has room", async () => {
		startedAt("A2VLJN", new Date());
		const asked = Date.now();

		const start = await awaitCouncilStart(path, onRoom("ISXEG8", roomy));

		expect(start.waited, "it started at once").toBeUndefined();
		expect(Date.now() - asked, "no spacing held it").toBeLessThan(SPACING);
		expect(line().started.by).toBe("ISXEG8");
	});

	it("waits while the machine is short, then starts, saying what it was short of", async () => {
		let looks = 0;
		const room = async () => {
			looks += 1;
			return looks <= 3 ? "memory full avg60 was 14, at or past 10" : undefined;
		};

		const start = await awaitCouncilStart(path, onRoom("ISXEG8", room));

		expect(looks, "it looked until there was room").toBe(4);
		expect(start.waited).toContain(
			"once those asked before it have and it has room",
		);
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

	it("starts rounds in the order asked, a look apart rather than a spacing", async () => {
		const joined = ["A2VLJN", "ISXEG8", "85PKB2"];
		const starts: number[] = [];
		const asked = Date.now();

		await Promise.all(
			joined.map((by) =>
				awaitCouncilStart(path, onRoom(by, roomy)).then(() => {
					starts.push(Date.now());
				}),
			),
		);

		expect(starts).toHaveLength(3);
		expect(Date.now() - asked, "all three inside one spacing").toBeLessThan(
			SPACING,
		);
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
		expect(stopped.cancelled).toContain("it has room");
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
		const joined = statSync(linePath()).ino;
		const joinedAt = looks;
		await expect
			.poll(() => looks, { timeout: 4_000, interval: 5 })
			.toBeGreaterThanOrEqual(joinedAt + 3);
		const later = statSync(linePath()).ino;
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
