/**
 * Work waited on no longer than a caller can afford gives what it
 * settled to in time, or nothing once the time has passed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { settledWithin } from "../../../lib/internal/settled.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("settledWithin", () => {
	it("gives what work settles to in time", async () => {
		expect(await settledWithin(Promise.resolve("judged"), 2500)).toBe("judged");
	});

	it("gives nothing once the time has passed on work that never settles", async () => {
		vi.useFakeTimers();
		const waiting = settledWithin(new Promise<string>(() => {}), 2500);

		await vi.advanceTimersByTimeAsync(2500);

		expect(await waiting).toBeUndefined();
	});

	it("fails as work that fails in time does", async () => {
		await expect(
			settledWithin(Promise.reject(new Error("the network has gone")), 2500),
		).rejects.toThrow("the network has gone");
	});

	it("leaves no timer behind once work settles", async () => {
		vi.useFakeTimers();

		await settledWithin(Promise.resolve("judged"), 2500);

		expect(vi.getTimerCount()).toBe(0);
	});
});
