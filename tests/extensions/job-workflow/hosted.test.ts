/**
 * Parked jobs on a host belong to the conversation they were parked for,
 * and on plain pi stay where every runtime since v1 looks for them.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Parked,
	park,
	takeParked,
} from "../../../extensions/job-workflow/carry.ts";
import type { JobSession } from "../../../extensions/job-workflow/lifecycle.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import { forgetParkedJobs } from "../../support/job-runtime.ts";
import { installTestHost } from "../../support/session-host.ts";

const V1 = Symbol.for("agentic-harness.jobs.parked.v1");
const pi = {} as ExtensionAPI;
const ctx = {} as ExtensionContext;
const session = (name: string) => ({ name }) as unknown as JobSession;

function parked(id: string, stops: string[]): Parked {
	return {
		session: id,
		adopt: () => session(id),
		stop: () => stops.push(id),
	};
}

afterEach(() => {
	vi.useRealTimers();
	forgetParkedJobs();
});

describe("parked jobs on plain pi", () => {
	it("are what an older copy left under v1, taken as it left them", () => {
		const stops: string[] = [];
		const timer = setTimeout(() => stops.push("timer"), 60_000);
		// What every runtime since v1 writes: the record itself, bare.
		(globalThis as Record<symbol, unknown>)[V1] = {
			parked: parked("s1", stops),
			timer,
		};

		expect(takeParked("s1", pi, ctx), "the new code adopts them").toEqual(
			session("s1"),
		);
		expect(V1 in globalThis, "taken means gone from the process").toBe(false);
		expect(stops, "nothing was stopped").toEqual([]);
	});

	it("are left as an older copy reads them, and one park still replaces another", () => {
		const stops: string[] = [];
		const first = parked("s1", stops);
		park(first);
		const left = (globalThis as Record<symbol, unknown>)[V1];
		expect(
			Object.keys(left as object).sort(),
			"the v1 record, byte for byte in shape",
		).toEqual(["parked", "timer"]);
		expect((left as { parked: Parked }).parked).toBe(first);

		park(parked("s2", stops));
		expect(stops, "one process holds one runtime's parked jobs").toEqual([
			"s1",
		]);
	});
});

describe("parked jobs on a host", () => {
	it("stay with their conversation: B's park stops none of A's, and A's wait ends only A's", () => {
		vi.useFakeTimers();
		const host = installTestHost();
		try {
			const stops: string[] = [];
			withSession("a", () => park(parked("a", stops), 1_000));
			withSession("b", () => park(parked("b", stops), 5_000));
			expect(stops, "B parking leaves A's jobs running").toEqual([]);
			expect(
				(globalThis as Record<symbol, unknown>)[V1],
				"nothing is parked on the process",
			).toBeUndefined();

			vi.advanceTimersByTime(1_000);
			expect(stops, "A's wait stops A's jobs alone").toEqual(["a"]);
			expect(
				withSession("b", () => takeParked("b", pi, ctx)),
				"B's are still there for B",
			).toEqual(session("b"));
		} finally {
			host.dispose();
		}
	});

	it("are taken only by their own conversation, and B's survive A's close", () => {
		vi.useFakeTimers();
		const host = installTestHost();
		try {
			const stops: string[] = [];
			withSession("a", () => park(parked("a", stops)));
			withSession("b", () => park(parked("b", stops)));

			expect(
				withSession("b", () => takeParked("a", pi, ctx)),
				"B naming A takes A's from A's cell",
			).toEqual(session("a"));
			withSession("a", () => park(parked("a", stops), 1_000));
			host.host.close("a", "closed");
			expect(
				withSession("a", () => takeParked("a", pi, ctx)),
				"A's close took its parked jobs with it",
			).toBeUndefined();
			expect(
				withSession("b", () => takeParked("b", pi, ctx)),
				"B's survive A's close",
			).toEqual(session("b"));
			expect(stops, "no conversation stopped another's").toEqual([]);
			vi.advanceTimersByTime(1_000);
			expect(stops, "A's jobs still stop once A's wait ends").toEqual(["a"]);
		} finally {
			host.dispose();
		}
	});
});
