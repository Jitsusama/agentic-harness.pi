import { getEventListeners } from "node:events";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deadline, WallClockExceeded } from "../../../lib/clock/index.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("a deadline", () => {
	it("fires once its clock runs out, saying what took too long", () => {
		vi.useFakeTimers();
		const clock = deadline(5000, "the review");
		vi.advanceTimersByTime(4999);
		expect(clock.signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);

		expect(clock.signal.aborted).toBe(true);
		expect(clock.expired).toBe(true);
		expect(clock.signal.reason).toBeInstanceOf(WallClockExceeded);
		expect(clock.signal.reason).toMatchObject({ name: "TimeoutError" });
		expect(String(clock.signal.reason.message)).toContain("the review");
	});

	it("fires with the followed signal's own reason, and stops its clock", () => {
		vi.useFakeTimers();
		const run = new AbortController();
		const clock = deadline(5000, "the review", run.signal);
		const why = new Error("the person stopped it");
		run.abort(why);

		expect(clock.signal.aborted).toBe(true);
		expect(clock.signal.reason).toBe(why);
		expect(clock.expired).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("fires at once when the followed signal already has", () => {
		const run = new AbortController();
		run.abort("gone");
		const clock = deadline(5000, "the review", run.signal);

		expect(clock.signal.aborted).toBe(true);
		expect(clock.signal.reason).toBe("gone");
	});

	it("once ended, neither fires, and the followed signal holds nothing of it", () => {
		vi.useFakeTimers();
		const run = new AbortController();
		const clock = deadline(5000, "the review", run.signal);
		expect(getEventListeners(run.signal, "abort")).toHaveLength(1);
		clock.end();
		vi.advanceTimersByTime(10_000);
		run.abort();

		expect(clock.signal.aborted).toBe(false);
		expect(getEventListeners(run.signal, "abort")).toHaveLength(0);
	});

	it("lets go of the followed signal once its clock runs out", () => {
		vi.useFakeTimers();
		const run = new AbortController();
		deadline(5000, "the review", run.signal);
		vi.advanceTimersByTime(5000);

		expect(getEventListeners(run.signal, "abort")).toHaveLength(0);
	});
});

describe("a signal joined to a deadline, over a run a bare abort stops", () => {
	// Node 22 keeps an AbortSignal.any with a timeout signal among its
	// sources for good once another source aborts it, and through its
	// reason's frames, whatever the abort's callers held (lib/clock's
	// deadline.ts says how). One pi held 164 of 475 MiB this way.
	setFlagsFromString("--expose-gc");
	const gc = runInNewContext("gc") as () => void;

	/** How many of 100 joined signals are still held after the run's abort. */
	async function heldAfterAbort(
		join: (run: AbortSignal) => AbortSignal,
	): Promise<number> {
		const joined: WeakRef<AbortSignal>[] = [];
		for (let i = 0; i < 100; i++) {
			const run = new AbortController();
			joined.push(new WeakRef(join(run.signal)));
			run.abort();
		}
		for (let i = 0; i < 3; i++) {
			await new Promise((resolve) => setImmediate(resolve));
			gc();
		}
		return joined.filter((signal) => signal.deref() !== undefined).length;
	}

	it("is let go of", async () => {
		const held = await heldAfterAbort((run) =>
			AbortSignal.any([run, deadline(60_000, "a review").signal]),
		);

		expect(held, "joined signals still held").toBe(0);
	});

	it.runIf(process.versions.node.startsWith("22."))(
		"is held for good on node 22 when the clock is node's own",
		async () => {
			// What the case above would see without the deadline, so it
			// can't pass by failing to see a leak at all.
			const held = await heldAfterAbort((run) =>
				AbortSignal.any([run, AbortSignal.timeout(60_000)]),
			);

			expect(held, "joined signals still held").toBe(100);
		},
	);
});
