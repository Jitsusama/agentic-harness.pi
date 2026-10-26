import { describe, expect, it, vi } from "vitest";
import {
	abortError,
	bounded,
	isAbort,
	WallClockExceeded,
} from "../../../lib/core/web/bound.ts";

/** A promise that settles only when told to. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("bounded", () => {
	it("answers with the work when it finishes in time", async () => {
		const giveUp = vi.fn();

		const out = await bounded(
			Promise.resolve(42),
			{ wallMs: 1000, what: "w" },
			giveUp,
		);

		expect(out).toBe(42);
		expect(giveUp).not.toHaveBeenCalled();
	});

	it("passes the work's own failure on untouched", async () => {
		const boom = new Error("boom");

		await expect(
			bounded(Promise.reject(boom), { wallMs: 1000, what: "w" }),
		).rejects.toBe(boom);
	});

	it("gives up when the signal fires, says it aborted, and tears down", async () => {
		const controller = new AbortController();
		const work = deferred<number>();
		const giveUp = vi.fn();

		const racing = bounded(
			work.promise,
			{ signal: controller.signal, wallMs: 60_000, what: "w" },
			giveUp,
		);
		controller.abort();

		await expect(racing).rejects.toSatisfy(isAbort);
		expect(giveUp).toHaveBeenCalledOnce();
	});

	it("does not start waiting on a signal that has already fired", async () => {
		const controller = new AbortController();
		controller.abort();
		const giveUp = vi.fn();

		await expect(
			bounded(
				deferred<number>().promise,
				{ signal: controller.signal, wallMs: 60_000, what: "w" },
				giveUp,
			),
		).rejects.toSatisfy(isAbort);
		expect(giveUp).toHaveBeenCalledOnce();
	});

	it("gives up at the wall clock and names what took too long", async () => {
		vi.useFakeTimers();
		try {
			const giveUp = vi.fn();
			const racing = bounded(
				deferred<number>().promise,
				{ wallMs: 30_000, what: "reading https://example.com" },
				giveUp,
			);
			const seen = racing.catch((err: unknown) => err);

			await vi.advanceTimersByTimeAsync(30_000);

			const err = await seen;
			expect(err).toBeInstanceOf(WallClockExceeded);
			expect((err as Error).name).toBe("TimeoutError");
			expect((err as Error).message).toContain("reading https://example.com");
			expect((err as Error).message).toContain("30 s");
			expect(giveUp).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("drops a late failure from work it never waited on", async () => {
		// An abort that came first means the race never starts, so
		// nothing else is listening when the work fails later.
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			const controller = new AbortController();
			controller.abort();
			const work = deferred<number>();
			await bounded(work.promise, {
				signal: controller.signal,
				wallMs: 60_000,
				what: "w",
			}).catch(() => {});

			work.reject(new Error("target closed"));
			await new Promise((wake) => setTimeout(wake, 10));

			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});

	it("stops listening once the work is done", async () => {
		const controller = new AbortController();
		const giveUp = vi.fn();

		await bounded(
			Promise.resolve(1),
			{ signal: controller.signal, wallMs: 1000, what: "w" },
			giveUp,
		);
		controller.abort();

		expect(giveUp).not.toHaveBeenCalled();
	});
});

describe("abortError", () => {
	it("passes on a caller's own abort reason", () => {
		const controller = new AbortController();
		controller.abort();

		expect(abortError(controller.signal)).toBe(controller.signal.reason);
	});

	it("makes an abort of its own when the reason is something else", () => {
		const controller = new AbortController();
		controller.abort("stop");

		const err = abortError(controller.signal);

		expect(err.name).toBe("AbortError");
		expect(err).toBeInstanceOf(Error);
	});
});
