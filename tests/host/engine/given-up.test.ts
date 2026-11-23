/**
 * Resting a conversation the host still holds whose child was given up
 * before it ran there: its park marker is written naming this host's
 * wake file, as a park writes it, so a sender's wake reaches the watch
 * the host then keeps (F167).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restGivenUp } from "../../../host/engine/given-up.ts";
import { parking } from "../../../host/engine/parking.ts";
import type { RosterEntry } from "../../../lib/core/session/roster.ts";
import {
	askWake,
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

		expect(restGivenUp(entry(), host.place), "rested").toBe(true);

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

		expect(restGivenUp(entry(), host.place)).toBe(true);

		expect(readParked(A, host.parks), "its own park's marker kept").toEqual(
			before,
		);
		expect(host.takenOn).toEqual([A]);
		host.parked.unwatch(A);
	});

	it("is refused, writing and watching nothing, while this host runs it", () => {
		const host = hostParking(true);

		expect(restGivenUp(entry(), host.place)).toBe(false);

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

		expect(restGivenUp(entry(), host.place)).toBe(false);

		expect(readParked(A, host.parks), "the other host's marker").toEqual(
			elsewhere,
		);
		expect(host.takenOn).toEqual([]);
	});
});
