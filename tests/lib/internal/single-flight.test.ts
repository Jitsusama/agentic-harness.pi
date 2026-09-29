import { describe, expect, it } from "vitest";
import { singleFlight } from "../../../lib/internal/single-flight.ts";

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
