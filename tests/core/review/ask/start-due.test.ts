/**
 * The start a waiting round is due at: set as it joins the line, from
 * its place and the last hour's starts, and told to its asker once
 * each time it passes unstarted (1JQPPC, 27 November).
 *
 * Driven on a real line on disk with an injected clock: each look reads
 * the machine's room, which is where a test steps the clock, reads the
 * line and, at the end, stops the round, so nothing here sleeps.
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
	TOLD_AGAIN_AFTER_MS,
} from "../../../../lib/core/review/ask/start-spacing.ts";

/** The line's spacing in these tests. */
const SPACING = 60_000;
/** When each test begins, by its clock. */
const BEGIN = Date.parse("2026-11-27T20:00:00.000Z");
/** What holds the machine while a test keeps a round from starting. */
const HELD: RoomHeld = {
	said: "memory full avg60 was 9, at or past 5",
	readings: ["memory full avg60"],
	passable: false,
};

let folder: string;
let path: string;
let now: number;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "start-due-"));
	path = join(folder, "starts", "last.json");
	mkdirSync(join(folder, "starts"), { recursive: true });
	now = BEGIN;
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const at = (ms: number) => new Date(ms).toISOString();
const line = () =>
	JSON.parse(readFileSync(join(folder, "starts", "line.json"), "utf8"));
/** The start the line has the test's round due at. */
const dueOnLine = (): string | undefined =>
	line().waiting.find((each: { by: string }) => each.by === "A2VLJN")?.dueAt;

/** What a round was told of while it waited, and how its wait ended. */
interface Waited {
	readonly told: { said: string; dueAt: string; nextDueAt: string }[];
	readonly started: boolean;
}

/**
 * Waits a round through `looks`, one a look: each may step the clock
 * and answers what holds the machine then. A look past the last stops
 * the round.
 */
async function waitThrough(
	looks: readonly (() => RoomHeld | undefined)[],
): Promise<Waited> {
	const told: Waited["told"] = [];
	const stop = new AbortController();
	let look = 0;
	const start = await awaitCouncilStart(
		path,
		{
			by: "A2VLJN",
			change: "o/r#1",
			kind: "council",
			spacingMs: SPACING,
			lookAgainMs: 1,
			alive: () => true,
			now: () => now,
			room: async () => {
				const step = looks[look];
				look += 1;
				if (step === undefined) {
					stop.abort();
					return HELD;
				}
				return step();
			},
			overdue: (lapse) => told.push({ ...lapse }),
		},
		stop.signal,
	);
	return { told, started: start.cancelled === undefined };
}

/** Starts the history keeps for the line, one at each time given. */
function startsKept(times: readonly number[]): void {
	const history = join(folder, "starts", "history");
	mkdirSync(history, { recursive: true });
	const lines = times.map((startAt, place) =>
		JSON.stringify({
			ticket: `t${place}`,
			by: "ISXEG8",
			change: `o/r#${place + 10}`,
			askedAt: at(startAt - 1000),
			startAt: at(startAt),
			waitedMs: 1000,
		}),
	);
	writeFileSync(
		join(history, "2026-11-27.jsonl"),
		`${lines.join("\n")}\n{"cut short\n`,
	);
}

describe("a round joining the start line", () => {
	it("is due its place in spacings from now", async () => {
		const ahead = (by: string, askedMs: number) => ({
			id: `ticket-${by}`,
			by,
			change: `o/r#${by}`,
			pid: process.pid,
			askedAt: at(askedMs),
			seenAt: at(BEGIN),
		});
		writeFileSync(
			join(folder, "starts", "line.json"),
			JSON.stringify({
				started: { at: at(BEGIN - 60 * 60_000), by: "X", change: "o/r#0" },
				waiting: [ahead("ISXEG8", BEGIN - 2000), ahead("85PKB2", BEGIN - 1000)],
			}),
		);
		let due: string | undefined;

		await waitThrough([
			() => undefined,
			() => {
				due = dueOnLine();
				return undefined;
			},
		]);

		expect(due, "third in line, three spacings out").toBe(
			at(BEGIN + 3 * SPACING),
		);
	});

	it("is due at the last hour's pace when the history shows one slower", async () => {
		// Four starts in the hour, a quarter-hour each; one before it,
		// which paces nothing.
		startsKept([
			BEGIN - 90 * 60_000,
			BEGIN - 50 * 60_000,
			BEGIN - 30 * 60_000,
			BEGIN - 20 * 60_000,
			BEGIN - 5 * 60_000,
		]);
		let due: string | undefined;

		await waitThrough([
			() => HELD,
			() => {
				due = dueOnLine();
				return HELD;
			},
		]);

		expect(due, "first in line at four starts an hour").toBe(
			at(BEGIN + 15 * 60_000),
		);
	});
});

describe("a round past the start it was due at", () => {
	it("tells its asker once where it stands, and is due again later", async () => {
		const lapsed = BEGIN + SPACING + 1000;
		let due: string | undefined;

		const { told } = await waitThrough([
			() => HELD,
			() => {
				now = lapsed;
				return HELD;
			},
			() => {
				due = dueOnLine();
				return HELD;
			},
		]);

		expect(told, "told once").toHaveLength(1);
		const [lapse] = told;
		expect(lapse?.dueAt, "the start it passed").toBe(at(BEGIN + SPACING));
		expect(lapse?.nextDueAt, "due again no sooner than it may tell again").toBe(
			at(lapsed + TOLD_AGAIN_AFTER_MS),
		);
		expect(due, "the line keeps the new due start").toBe(lapse?.nextDueAt);
		expect(lapse?.said).toContain("position 1 of 1 in the start line");
		expect(lapse?.said, "what holds the line").toContain(HELD.said);
		expect(lapse?.said).toContain(`due now by ${lapse?.nextDueAt}`);
	});

	it("tells nothing more at a look before its new due start", async () => {
		const lapsed = BEGIN + SPACING + 1000;

		const { told } = await waitThrough([
			() => HELD,
			() => {
				now = lapsed;
				return HELD;
			},
			() => {
				// Past a spacing from the lapse, short of the new due start.
				now = lapsed + TOLD_AGAIN_AFTER_MS - 60_000;
				return HELD;
			},
		]);

		expect(told, "told for the one lapse only").toHaveLength(1);
	});
});

describe("a round that starts before it is due", () => {
	it("tells its asker nothing", async () => {
		const { told, started } = await waitThrough([
			() => HELD,
			() => {
				now = BEGIN + SPACING / 2;
				return HELD;
			},
			() => {
				now = BEGIN + SPACING - 1000;
				return undefined;
			},
		]);

		expect(started, "it started").toBe(true);
		expect(told, "nothing to tell").toEqual([]);
	});
});
