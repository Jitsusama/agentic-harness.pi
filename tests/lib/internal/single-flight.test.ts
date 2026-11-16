import { describe, expect, it } from "vitest";
import {
	coalescing,
	loadOnce,
	singleFlight,
} from "../../../lib/internal/single-flight.ts";

/** A start whose answer the test hands over when it chooses. */
function pending<V>() {
	let resolve: (value: V) => void = () => {};
	let reject: (error: unknown) => void = () => {};
	let starts = 0;
	const start = () => {
		starts += 1;
		return new Promise<V>((res, rej) => {
			resolve = res;
			reject = rej;
		});
	};
	return {
		start,
		starts: () => starts,
		resolve: (value: V) => resolve(value),
		reject: (error: unknown) => reject(error),
	};
}

describe("singleFlight", () => {
	it("starts one flight for callers who ask while it is up", async () => {
		// Two tool calls in the same turn each found no client and each
		// began a login, two panels and two callback servers for one.
		const flight = singleFlight<string, string>();
		const login = pending<string>();

		const first = flight("default", login.start);
		const second = flight("default", login.start);
		expect(login.starts()).toBe(1);
		login.resolve("client");

		expect(await first).toBe("client");
		expect(await second).toBe("client");
	});

	it("keeps flights for different keys apart", async () => {
		const flight = singleFlight<string, string>();
		const work = pending<string>();
		const personal = pending<string>();

		const a = flight("work", work.start);
		const b = flight("personal", personal.start);
		work.resolve("work client");
		personal.resolve("personal client");

		expect(await a).toBe("work client");
		expect(await b).toBe("personal client");
	});

	it("starts afresh once a flight has landed", async () => {
		// Remembering the answer is the caller's cache; this only joins
		// what is still in the air.
		const flight = singleFlight<string, string>();
		const login = pending<string>();

		const first = flight("default", login.start);
		login.resolve("client");
		await first;
		const again = flight("default", login.start);
		login.resolve("second client");

		expect(await again).toBe("second client");
		expect(login.starts()).toBe(2);
	});

	it("shares a failure with the callers who waited, then forgets it", async () => {
		// A cancelled login must not be the answer to every later call.
		const flight = singleFlight<string, string>();
		const login = pending<string>();

		const first = flight("default", login.start);
		const second = flight("default", login.start);
		expect(login.starts()).toBe(1);
		login.reject(new Error("cancelled"));

		await expect(first).rejects.toThrow("cancelled");
		await expect(second).rejects.toThrow("cancelled");
		const retry = flight("default", login.start);
		login.resolve("client");
		expect(await retry).toBe("client");
		expect(login.starts()).toBe(2);
	});
});

describe("loadOnce", () => {
	it("loads once for callers who ask while it loads", async () => {
		// pi's loader handed a second import of a module still being
		// evaluated the half-made module, so two of three review_offer
		// calls made at once found their imports undefined.
		const module = pending<string>();
		const load = loadOnce(module.start);

		const calls = [load(), load(), load()];
		expect(module.starts(), "one load for three callers").toBe(1);
		module.resolve("offer");

		expect(await Promise.all(calls)).toEqual(["offer", "offer", "offer"]);
	});

	it("keeps a module once it has loaded", async () => {
		const module = pending<string>();
		const load = loadOnce(module.start);

		const first = load();
		module.resolve("offer");
		await first;

		expect(await load(), "the loaded module").toBe("offer");
		expect(module.starts(), "no second load once loaded").toBe(1);
	});

	it("shares a failed load with the callers who waited, then tries again", async () => {
		// A file missing for a moment, as an install swaps, must not be
		// every later call's answer.
		const module = pending<string>();
		const load = loadOnce(module.start);

		const first = load();
		const second = load();
		module.reject(new Error("no such file"));

		await expect(first).rejects.toThrow("no such file");
		await expect(second).rejects.toThrow("no such file");
		const retry = load();
		module.resolve("offer");
		expect(await retry, "the module from the second load").toBe("offer");
		expect(module.starts(), "a second load after the failure").toBe(2);
	});
});

/** A promise and the hand that settles it, for work a test lets end. */
function held(): { done: Promise<void>; end: () => void; fail: () => void } {
	let end = (): void => undefined;
	let fail = (): void => undefined;
	const done = new Promise<void>((resolve, reject) => {
		end = resolve;
		fail = () => reject(new Error("the disk went away"));
	});
	return { done, end, fail };
}

// A steer watcher's ask can't be passed over the way a clock's tick is,
// or what arrived during a take would wait for the next minute.
describe("coalescing", () => {
	it("runs once more after it ends, however many asks came while it ran", async () => {
		const runs: ReturnType<typeof held>[] = [];
		const take = coalescing(() => {
			const one = held();
			runs.push(one);
			return one.done;
		});

		const first = take();
		const asks = [take(), take(), take()];
		expect(runs, "none ran beside the first").toHaveLength(1);

		runs[0]?.end();
		await first;
		await Promise.resolve();
		expect(runs, "one more run for every ask that came meanwhile").toHaveLength(
			2,
		);
		runs[1]?.end();
		await Promise.all(asks);
		expect(runs, "and no more").toHaveLength(2);
	});

	it("answers each ask once the run that covers it has ended", async () => {
		const runs: ReturnType<typeof held>[] = [];
		const take = coalescing(() => {
			const one = held();
			runs.push(one);
			return one.done;
		});
		let covered = false;

		void take();
		const later = take().then(() => {
			covered = true;
		});
		runs[0]?.end();
		await new Promise((settle) => setImmediate(settle));
		expect(covered, "the run it came during does not cover it").toBe(false);

		runs[1]?.end();
		await later;
		expect(covered, "the run after it does").toBe(true);
	});

	it("runs again after a run that failed, and still answers its asks", async () => {
		const runs: ReturnType<typeof held>[] = [];
		const take = coalescing(() => {
			const one = held();
			runs.push(one);
			return one.done;
		});

		const failing = take();
		const after = take();
		runs[0]?.fail();
		await expect(failing).rejects.toThrow("the disk went away");
		await new Promise((settle) => setImmediate(settle));
		expect(runs, "the ask that came meanwhile still runs").toHaveLength(2);
		runs[1]?.end();
		await expect(after).resolves.toBeUndefined();
	});
});
