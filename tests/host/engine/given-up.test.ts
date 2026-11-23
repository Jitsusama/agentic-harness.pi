/**
 * Resting a conversation the host still holds whose child was given up
 * before it ran there: its park marker is written naming this host's
 * wake file, as a park writes it, so a sender's wake reaches the watch
 * the host then keeps (F167).
 */
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restGivenUp } from "../../../host/engine/given-up.ts";
import { parking } from "../../../host/engine/parking.ts";
import type { RosterEntry } from "../../../lib/core/session/roster.ts";
import {
	askWake,
	parkedPath,
	readParked,
	writeParked,
} from "../../../lib/internal/session/park.ts";
import { until } from "../../support/until.ts";

const A = "a0000000-0000-4000-8000-000000000001";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "given-up-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** The roster's entry for `A`, with a quest. */
function entry(): RosterEntry {
	return {
		sessionId: A,
		file: join(dir, `${A}.jsonl`),
		cwd: dir,
		attended: false,
		quest: "QEST-1",
		since: "2026-11-23T02:00:00.000Z",
	};
}

/** A host's parking, whose wakes `asking` hears, and where its markers lie. */
function hostParking(runs = false) {
	const asking = vi.fn((_sessionId: string) => Promise.resolve());
	const parked = parking({
		stateDir: join(dir, "engine"),
		stop: async () => undefined,
		asking: () => asking,
		report: vi.fn(),
	});
	const takenOn: string[] = [];
	const parks = join(dir, "parks");
	const place = {
		runs: () => runs,
		wakeFile: (sessionId: string) => parked.wakeFile(sessionId),
		watches: (sessionId: string) => parked.watches(sessionId),
		takeOn: (held: RosterEntry) => {
			takenOn.push(held.sessionId);
			parked.rests(held.sessionId);
		},
		folder: parks,
		pid: 31337,
	};
	return { asking, parked, takenOn, parks, place };
}

describe("a given-up child's conversation", () => {
	it("rests with a park marker naming this host's wake file, and wakes at a sender's wake", async () => {
		const host = hostParking();

		expect(restGivenUp(entry(), host.place), "rested").toBeUndefined();

		const marker = readParked(A, host.parks);
		expect(marker, "its marker, as a park writes it").toMatchObject({
			session: A,
			sessionFile: entry().file,
			cwd: dir,
			quest: "QEST-1",
			pid: 31337,
			wake: host.parked.wakeFile(A),
		});
		expect(host.takenOn, "taken on as a resting one").toEqual([A]);
		expect(askWake(A, "2f95756a", host.parks), "a sender asked").toBe(true);
		await until("the sender's wake to wake it", () =>
			host.asking.mock.calls.some(([id]) => id === A),
		);
		host.parked.unwatch(A);
	});

	it("keeps a marker naming this host's wake already, resting it as restsParked would", () => {
		const host = hostParking();
		const before = {
			session: A,
			sessionFile: entry().file,
			cwd: dir,
			addresses: ["A1B2C3"],
			parkedAt: "2026-11-23T01:00:00.000Z",
			pid: 4242,
			wake: host.parked.wakeFile(A),
		};
		writeParked(before, host.parks);

		expect(restGivenUp(entry(), host.place)).toBeUndefined();

		expect(readParked(A, host.parks), "its own park's marker kept").toEqual(
			before,
		);
		expect(host.takenOn).toEqual([A]);
		host.parked.unwatch(A);
	});

	it("is refused, writing and watching nothing, while this host runs it", () => {
		const host = hostParking(true);

		expect(restGivenUp(entry(), host.place)).toBe("this host runs it now");

		expect(readParked(A, host.parks), "no marker written").toBeUndefined();
		expect(host.takenOn).toEqual([]);
	});

	it("is refused, leaving its marker, while another host's wake holds it", () => {
		const host = hostParking();
		const elsewhere = {
			session: A,
			sessionFile: entry().file,
			cwd: dir,
			addresses: [],
			parkedAt: "2026-11-23T01:00:00.000Z",
			pid: 4242,
			wake: join(dir, "other-host", A, "wake"),
		};
		writeParked(elsewhere, host.parks);

		expect(restGivenUp(entry(), host.place)).toBe(
			`its marker names another holder's wake, ${elsewhere.wake}`,
		);

		expect(readParked(A, host.parks), "the other host's marker").toEqual(
			elsewhere,
		);
		expect(host.takenOn).toEqual([]);
	});

	// F30: a holder of an earlier boot runs nothing now.
	it("writes over a marker from an earlier boot, naming this host's wake", async () => {
		const host = hostParking();
		writeParked(
			{
				session: A,
				sessionFile: entry().file,
				cwd: dir,
				addresses: [],
				parkedAt: "2026-11-20T01:00:00.000Z",
				pid: 4242,
				wake: join(dir, "other-host", A, "wake"),
			},
			host.parks,
		);
		const longAgo = new Date(0);
		await utimes(parkedPath(A, host.parks), longAgo, longAgo);

		expect(restGivenUp(entry(), host.place)).toBeUndefined();

		expect(readParked(A, host.parks)?.wake, "this host's wake").toBe(
			host.parked.wakeFile(A),
		);
		expect(host.takenOn).toEqual([A]);
		host.parked.unwatch(A);
	});

	// F25: a sender is never sent to a wake nothing watches.
	it("takes back the marker it wrote when taking it on fails", () => {
		const host = hostParking();
		const place = {
			...host.place,
			takeOn: () => {
				throw new Error("no watch");
			},
		};

		expect(() => restGivenUp(entry(), place)).toThrow("no watch");

		expect(readParked(A, host.parks), "no marker left").toBeUndefined();
	});

	it("keeps a marker it didn't write when taking it on fails", () => {
		const host = hostParking();
		const before = {
			session: A,
			sessionFile: entry().file,
			cwd: dir,
			addresses: ["A1B2C3"],
			parkedAt: "2026-11-23T01:00:00.000Z",
			pid: 4242,
			wake: host.parked.wakeFile(A),
		};
		writeParked(before, host.parks);
		const place = {
			...host.place,
			takeOn: () => {
				throw new Error("no watch");
			},
		};

		expect(() => restGivenUp(entry(), place)).toThrow("no watch");

		expect(readParked(A, host.parks), "its own park's marker").toEqual(before);
	});

	// F23, F26, F27: a wake's give-up keeps the sleeper that woke it, with
	// the refusal and carried calls it holds, and writes back the marker
	// its pi's start cleared, so a sender still finds where to wake it.
	it("keeps the watch that woke it, writing back only its marker", async () => {
		const host = hostParking();
		host.parked.rests(A);

		expect(restGivenUp(entry(), host.place), "rested").toBeUndefined();

		expect(host.takenOn, "not taken on again").toEqual([]);
		expect(readParked(A, host.parks)?.wake, "its marker back").toBe(
			host.parked.wakeFile(A),
		);
		expect(askWake(A, "2f95756a", host.parks), "a sender asked").toBe(true);
		await until("the sender's wake to reach the first watch", () =>
			host.asking.mock.calls.some(([id]) => id === A),
		);
		host.parked.unwatch(A);
	});
});
