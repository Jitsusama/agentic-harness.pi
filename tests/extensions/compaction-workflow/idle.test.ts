import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idleTimer } from "../../../extensions/compaction-workflow/idle.ts";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the idle timer", () => {
	it("runs what it waits for once the session has been idle long enough", () => {
		const seen: ExtensionContext[] = [];
		const ctx = {} as ExtensionContext;
		idleTimer((idle) => seen.push(idle), 1_000).start(ctx);

		vi.advanceTimersByTime(1_000);

		expect(seen).toEqual([ctx]);
	});

	// A throw from a timer is uncaught and takes pi down, and a context
	// the session replaced throws on first use.
	it("keeps a stale context's throw from leaving the timer", () => {
		idleTimer(() => {
			throw new Error("This extension ctx is stale.");
		}, 1_000).start({} as ExtensionContext);

		expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
	});
});
