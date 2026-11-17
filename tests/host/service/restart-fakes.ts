/** The clock, timers and facts a host's restart tests set by hand. */
import { vi } from "vitest";
import {
	LOOK_MS,
	type RestartFacts,
	restartWhenSettled,
} from "../../../host/service/restart.ts";

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

/** A heap that reads `first` at the host's first look, and grows when told. */
export function growingHeap(first: number) {
	let share = first;
	return {
		heapShare: () => share,
		growTo: (next: number) => {
			share = next;
		},
	};
}

/** Collects each heap restart `given` asks for into `said`, with what it was under. */
export function restartsSaid(given: RestartFacts, said: string[]): void {
	given.restart = async (why, under) => {
		said.push(`restart under ${JSON.stringify(under)}: ${why}`);
	};
}

/**
 * A host restarting for `heap`, whose conversations park, wake and
 * close as a case says, with one background job held and a look a
 * minute; answers those steps, the looks, and the restarts and reports
 * it said. As the serving host's roster does, a parked conversation is
 * listed by parked() and left out of held(), and each wake begins it
 * anew, as the session host numbers it (serve.test.ts pins both).
 */
export function asleep(
	heap: ReturnType<typeof growingHeap>,
	more: Partial<RestartFacts> = {},
) {
	const awake = new Map<string, number>();
	const parked = new Set<string>();
	let begun = 0;
	let clock = NOW;
	const { facts: given, said } = facts({
		differs: async () => "its heap is past half",
		held: () =>
			[...awake].map(([id, at]) => ({
				id,
				begun: at,
				state: "idle" as const,
				since: lately,
			})),
		parked: () => [...parked],
		background: () => 1,
		heapShare: heap.heapShare,
		now: () => clock,
		...more,
	});
	restartsSaid(given, said);
	const timers = manualTimers();
	restartWhenSettled(given, { after: timers.after });
	return {
		wake(...ids: string[]) {
			for (const id of ids) {
				parked.delete(id);
				awake.set(id, ++begun);
			}
		},
		park(...ids: string[]) {
			for (const id of ids) {
				awake.delete(id);
				parked.add(id);
			}
		},
		close(...ids: string[]) {
			for (const id of ids) {
				awake.delete(id);
				parked.delete(id);
			}
		},
		// A look a minute on, at the share given.
		async look(share: number) {
			heap.growTo(share);
			clock += LOOK_MS;
			await timers.fire();
		},
		restarts: () => said.filter((line) => line.startsWith("restart")),
		reports: () => said.filter((line) => line.startsWith("report:")),
	};
}
