import { describe, expect, it } from "vitest";
import { createMutex } from "../../../lib/internal/async-mutex";

/** A deferred promise plus its resolver, for hand-driving task timing. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("createMutex", () => {
	it("runs critical sections one at a time, never overlapping", async () => {
		const mutex = createMutex();
		const events: string[] = [];
		const first = deferred<void>();

		const a = mutex.runExclusive(async () => {
			events.push("a:start");
			await first.promise;
			events.push("a:end");
		});
		const b = mutex.runExclusive(async () => {
			events.push("b:start");
		});

		// b must not start until a releases, even though both
		// were queued synchronously before a's await settled.
		await Promise.resolve();
		expect(events).toEqual(["a:start"]);

		first.resolve();
		await Promise.all([a, b]);
		expect(events).toEqual(["a:start", "a:end", "b:start"]);
	});

	it("preserves FIFO order across many queued tasks", async () => {
		const mutex = createMutex();
		const order: number[] = [];
		const tasks = [0, 1, 2, 3, 4].map((n) =>
			mutex.runExclusive(async () => {
				order.push(n);
			}),
		);
		await Promise.all(tasks);
		expect(order).toEqual([0, 1, 2, 3, 4]);
	});

	it("returns each task's resolved value to its own caller", async () => {
		const mutex = createMutex();
		const [x, y] = await Promise.all([
			mutex.runExclusive(async () => "x"),
			mutex.runExclusive(async () => "y"),
		]);
		expect(x).toBe("x");
		expect(y).toBe("y");
	});

	it("propagates a task rejection without stalling the queue", async () => {
		const mutex = createMutex();
		const failed = mutex.runExclusive(async () => {
			throw new Error("boom");
		});
		await expect(failed).rejects.toThrow("boom");

		// The lock must release after a failure so later tasks run.
		const after = await mutex.runExclusive(async () => "recovered");
		expect(after).toBe("recovered");
	});
});
