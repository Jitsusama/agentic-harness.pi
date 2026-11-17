/** The clock, timers and facts a host's restart tests set by hand. */
import { vi } from "vitest";
import type { RestartFacts } from "../../../host/service/restart.ts";

/** The moment every restart test runs at. */
export const NOW = Date.parse("2026-11-10T20:00:00Z");
/** A mebibyte, as V8 counts its heap. */
export const MB = 1024 * 1024;
/** A change long enough ago to count as settled. */
export const long = new Date(NOW - 10 * 60_000).toISOString();
/** A change too recent to count as settled. */
export const lately = new Date(NOW - 30_000).toISOString();

/** Timers the test fires by hand, in the order they were set. */
export function manualTimers() {
	const waiting: { ms: number; run: () => void; cancelled: boolean }[] = [];
	return {
		after(ms: number, run: () => void) {
			const timer = { ms, run, cancelled: false };
			waiting.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		pending: () => waiting.filter((timer) => !timer.cancelled),
		/**
		 * Run the next timer and wait until its look is over: by default
		 * until it set the next, or until `over` says so for one that
		 * restarted and sets none.
		 */
		async fire(over = () => waiting.length > 0) {
			const timer = waiting.shift();
			if (!timer) throw new Error("No timer is waiting");
			if (!timer.cancelled) timer.run();
			await vi.waitFor(
				() => {
					if (!over()) throw new Error("The look hasn't finished");
				},
				// A look awaits only promises the test resolves at once.
				{ interval: 1 },
			);
		},
	};
}

/** A settled host whose install moved, saying what it did into `said`. */
export function facts(overrides: Partial<RestartFacts> = {}) {
	const said: string[] = [];
	const base: RestartFacts = {
		differs: async () => "the install moved",
		held: () => [{ state: "idle", since: long }],
		background: () => 0,
		resting: () => true,
		stopping: () => false,
		expect: (coming) => said.push(`expect ${coming}`),
		restart: async (why) => {
			said.push(`restart: ${why}`);
		},
		report: (error) => said.push(`report: ${String(error)}`),
		now: () => NOW,
		...overrides,
	};
	return { facts: base, said };
}
