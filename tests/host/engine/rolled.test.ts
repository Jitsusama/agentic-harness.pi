/** Saying in a parking conversation's log that it rolls onto new host code. */
import { describe, expect, it } from "vitest";
import { sayRolled } from "../../../host/engine/rolled.ts";
import {
	HOST_ROLLED_ENTRY,
	type RolledCode,
} from "../../../lib/core/session/host.ts";
import type { CarriedShell } from "../../../lib/internal/shell/carried.ts";
import { JOBS_CARRIED, type JobsCarried } from "../../../lib/jobs/host.ts";

const CODE: RolledCode = { from: "75fbcd04", onto: "a3d6275e" };
const AT = new Date("2026-11-27T09:00:00.000Z");

/** A bus that hands what's said on it to whoever listens. */
function fakeBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel: string, listener: (data: unknown) => void) {
			const set = listeners.get(channel) ?? new Set();
			set.add(listener);
			listeners.set(channel, set);
			return () => set.delete(listener);
		},
		emit(channel: string, data: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(data);
		},
	};
}

/** What a park carries: one bash call. */
function carried(): JobsCarried {
	const work: CarriedShell = {
		kind: "shell",
		keep: "/kept/one",
		pid: 4242,
		mark: "mark-one",
		startedAt: 1,
	};
	return {
		session: "s1",
		jobs: [{ id: "j1", kind: "bash", label: "sleep", work }],
	};
}

/** A conversation whose log keeps what's appended, parking until told otherwise. */
function conversation(over: { failOn?: number } = {}) {
	const entries: { customType: string; data: unknown }[] = [];
	const reported: unknown[] = [];
	const bus = fakeBus();
	const state = { parking: true };
	return {
		entries,
		reported,
		bus,
		state,
		parts: {
			log: {
				appendCustomEntry(customType: string, data?: unknown) {
					if (over.failOn === entries.length) throw new Error("log is gone");
					entries.push({ customType, data });
				},
			},
			bus,
			parking: () => state.parking,
			report: (error: unknown) => reported.push(error),
		},
	};
}

/** A host that rolls `rolling` sessions from and onto `code`. */
function host(code: RolledCode | undefined, rolling = true) {
	return { rolling: () => rolling, rolledCode: () => code };
}

describe("saying a conversation's roll", () => {
	it("says in its log that it rolls, naming the code and when", () => {
		const talk = conversation();

		sayRolled(host(CODE), "s1", talk.parts, () => AT);

		expect(talk.entries).toEqual([
			{
				customType: HOST_ROLLED_ENTRY,
				data: { ...CODE, at: AT.toISOString() },
			},
		]);
	});

	it("says once that the host wakes it, however often its park carries calls", () => {
		const talk = conversation();
		sayRolled(host(CODE), "s1", talk.parts, () => AT);

		talk.bus.emit(JOBS_CARRIED, carried());
		talk.bus.emit(JOBS_CARRIED, carried());

		expect(talk.entries.map((entry) => entry.data)).toEqual([
			{ ...CODE, at: AT.toISOString() },
			{ ...CODE, at: AT.toISOString(), wakes: true },
		]);
	});

	it("hears no carry once it no longer parks, or once it stops hearing", () => {
		const notParking = conversation();
		sayRolled(host(CODE), "s1", notParking.parts, () => AT);
		notParking.state.parking = false;
		notParking.bus.emit(JOBS_CARRIED, carried());
		expect(notParking.entries, "a carry after its park").toHaveLength(1);

		const stopped = conversation();
		const stop = sayRolled(host(CODE), "s1", stopped.parts, () => AT);
		stop();
		stopped.bus.emit(JOBS_CARRIED, carried());
		expect(stopped.entries, "a carry once it stopped hearing").toHaveLength(1);
	});

	it("says nothing where it doesn't roll, or its roll names no code", () => {
		const parksOnly = conversation();
		sayRolled(host(CODE, false), "s1", parksOnly.parts, () => AT);
		parksOnly.bus.emit(JOBS_CARRIED, carried());
		expect(parksOnly.entries, "a park that isn't a roll").toEqual([]);

		const unnamed = conversation();
		sayRolled(host(undefined), "s1", unnamed.parts, () => AT);
		unnamed.bus.emit(JOBS_CARRIED, carried());
		expect(unnamed.entries, "a roll naming no code").toEqual([]);
	});

	it("reports a wake it can't write, and goes on", () => {
		const talk = conversation({ failOn: 1 });
		sayRolled(host(CODE), "s1", talk.parts, () => AT);

		expect(() => talk.bus.emit(JOBS_CARRIED, carried())).not.toThrow();

		expect(talk.entries).toHaveLength(1);
		expect(talk.reported).toEqual([new Error("log is gone")]);
	});
});
