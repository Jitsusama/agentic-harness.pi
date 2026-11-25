/**
 * Taking back a park that failed part-way, and answering the person's
 * Park by how much of it was taken back.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerParkNow } from "../../../extensions/park-workflow/park-now.ts";
import {
	exitWith,
	takeBackExit,
} from "../../../extensions/park-workflow/restart.ts";
import {
	type HalfPark,
	ParkLeftHalfDone,
	undoPark,
} from "../../../extensions/park-workflow/undo.ts";
import {
	PARK_UNDONE,
	PARKED_EXIT,
	type ParkNowAsk,
	parkedPath,
	readParked,
	writeParked,
} from "../../../lib/internal/session/park.ts";

const SESSION = "01a1af3c-26bc-7b80-990f-37848859ff67";
const HELD_PID = 4242;

let folder: string;
let said: [string, unknown][];

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "park-undo-"));
	said = [];
	writeFileSync(join(folder, "held.json"), JSON.stringify({ pid: HELD_PID }));
	writeParked(
		{
			session: SESSION,
			sessionFile: join(folder, "session.jsonl"),
			cwd: folder,
			addresses: [],
			parkedAt: "2026-11-24T22:00:00.000Z",
			pid: HELD_PID,
			wake: join(folder, "held.wake"),
		},
		folder,
	);
});

afterEach(() => {
	takeBackExit();
	rmSync(folder, { recursive: true, force: true });
});

const half = (over: Partial<HalfPark> = {}): HalfPark => ({
	session: SESSION,
	folder,
	saidToHolder: false,
	env: {
		MYCELIUM_WAKE: join(folder, "held.wake"),
		MYCELIUM_PARKED: join(folder, "held.parked"),
	},
	pid: HELD_PID,
	bus: { emit: (channel, data) => said.push([channel, data]) },
	...over,
});

const thrown = (run: () => void): unknown => {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("nothing was thrown");
};

describe("taking back a half-done park", () => {
	it("takes back its marker, its wake and its word to its holder, then throws what failed", () => {
		const failed = new Error("its holder is gone");
		writeFileSync(join(folder, "held.wake"), "{}");
		writeFileSync(join(folder, "held.parked"), "");

		const error = thrown(() =>
			undoPark(
				failed,
				half({ wakeWritten: join(folder, "held.wake"), saidToHolder: true }),
			),
		);

		expect(error).toBe(failed);
		expect(readParked(SESSION, folder)).toBeUndefined();
		expect(existsSync(join(folder, "held.wake"))).toBe(false);
		expect(existsSync(join(folder, "held.parked"))).toBe(false);
		expect(said).toEqual([[PARK_UNDONE, { session: SESSION }]]);
	});

	it("leaves a holder's word it never gave, and a wake it never wrote", () => {
		writeFileSync(join(folder, "held.wake"), "{}");
		writeFileSync(join(folder, "held.parked"), "");

		thrown(() => undoPark(new Error("no"), half()));

		expect(existsSync(join(folder, "held.wake"))).toBe(true);
		expect(existsSync(join(folder, "held.parked"))).toBe(true);
	});

	it("tries every part, saying which it left where its first fails", () => {
		// A folder where its marker stands can't be taken out as a file can,
		// even by root.
		const marker = parkedPath(SESSION, folder);
		rmSync(marker);
		mkdirSync(join(marker, "in-the-way"), { recursive: true });
		writeFileSync(join(folder, "held.wake"), "{}");
		writeFileSync(join(folder, "held.parked"), "");

		const error = thrown(() =>
			undoPark(
				new Error("its holder is gone"),
				half({ wakeWritten: join(folder, "held.wake"), saidToHolder: true }),
			),
		);

		expect(error).toBeInstanceOf(ParkLeftHalfDone);
		expect((error as ParkLeftHalfDone).message).toBe("its holder is gone");
		const left = (error as ParkLeftHalfDone).left;
		expect(left).toHaveLength(1);
		expect(left[0]).toMatch(/^its parked marker is left: \S/);
		expect(existsSync(join(folder, "held.wake")), "its wake still").toBe(false);
		expect(existsSync(join(folder, "held.parked")), "its word still").toBe(
			false,
		);
		expect(said, "the mesh still told").toEqual([
			[PARK_UNDONE, { session: SESSION }],
		]);
	});

	it("names each part it left, in the order it tried them", () => {
		mkdirSync(join(folder, "held.parked", "in-the-way"), { recursive: true });

		const error = thrown(() =>
			undoPark(
				new Error("its holder is gone"),
				half({
					saidToHolder: true,
					bus: {
						emit: () => {
							throw new Error("the mesh is gone too");
						},
					},
				}),
			),
		);

		const left = (error as ParkLeftHalfDone).left;
		expect(left).toHaveLength(2);
		expect(left[0]).toMatch(/^its word to its holder is left: \S/);
		expect(left[1]).toBe("its word to the mesh is left: the mesh is gone too");
		expect(readParked(SESSION, folder), "its marker still taken back").toBe(
			undefined,
		);
	});

	it("takes back the code its process was to exit with", () => {
		const before = process.listenerCount("exit");
		exitWith(PARKED_EXIT);
		expect(process.listenerCount("exit"), "armed").toBe(before + 1);

		thrown(() => undoPark(new Error("no"), half({ saidToHolder: true })));

		expect(process.listenerCount("exit"), "disarmed").toBe(before);
	});

	it("arms one exit however often it is said", () => {
		const before = process.listenerCount("exit");
		exitWith(PARKED_EXIT);
		exitWith(PARKED_EXIT);
		expect(process.listenerCount("exit")).toBe(before + 1);
		takeBackExit();
		expect(process.listenerCount("exit")).toBe(before);
	});
});

describe("answering a park that failed", () => {
	const answer = (error: unknown): ParkNowAsk => {
		const ask: ParkNowAsk = { session: SESSION };
		answerParkNow(
			ask,
			() => undefined,
			() => {
				throw error;
			},
		);
		return ask;
	};

	it("says only that it failed where its park was taken back", () => {
		expect(answer(new Error("its holder is gone")).why).toBe(
			"its park failed: its holder is gone",
		);
	});

	it("warns it may read as parked where taking it back failed too, naming what is left", () => {
		expect(
			answer(
				new ParkLeftHalfDone(new Error("its holder is gone"), [
					"its parked marker is left: busy",
					"its wake is left: gone",
				]),
			).why,
		).toBe(
			"its park failed part-way, so it may read as parked until it is restarted: its holder is gone. And its parked marker is left: busy, and its wake is left: gone",
		);
	});

	it("says something of a failure that can't say itself", () => {
		expect(answer(Object.create(null)).why).toMatch(/^its park failed: \S/);
	});
});
