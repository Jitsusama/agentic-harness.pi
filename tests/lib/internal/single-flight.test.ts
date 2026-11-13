import { describe, expect, it } from "vitest";
import { loadOnce, singleFlight } from "../../../lib/internal/single-flight.ts";

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
