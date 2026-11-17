/**
 * A command stops with the call that started it.
 *
 * A review provider is built once and runs its commands through an
 * exec handed to it then, so nothing about one tool call can reach
 * the command that call makes: a gs or gh run went on to its clock
 * whatever Escape said. The call's signal travels with the call
 * instead, and a command started inside it stops when it fires.
 */

import { describe, expect, it, vi } from "vitest";
import {
	callSignal,
	withCallSignal,
} from "../../../lib/core/exec/call-signal.ts";
import {
	EXIT_ABORTED,
	type ExecResult,
	spawnExec,
} from "../../../lib/core/exec/spawn.ts";

/** What a run settled as within a short wait, or that it had not. */
async function within<T>(
	running: Promise<T>,
	ms = 2_000,
): Promise<T | "still running"> {
	return Promise.race([
		running,
		new Promise<"still running">((resolve) =>
			setTimeout(() => resolve("still running"), ms),
		),
	]);
}

describe("a command started inside a call", () => {
	it("stops when the call's signal fires", async () => {
		// Built before, and outside, any call, as a provider's is.
		const exec = spawnExec();
		const stop = new AbortController();
		const running = withCallSignal(stop.signal, () => exec("sleep", ["30"]));
		setTimeout(() => stop.abort(), 50);

		const result = await within(running);
		expect(result === "still running" ? result : result.code).toBe(
			EXIT_ABORTED,
		);
	}, 10_000);

	it("stops on its own signal too", async () => {
		const call = new AbortController();
		const own = new AbortController();
		const running = withCallSignal(call.signal, () =>
			spawnExec({ signal: own.signal })("sleep", ["30"]),
		);
		setTimeout(() => own.abort(), 50);

		const result = await within(running);
		expect(result === "still running" ? result : result.code).toBe(
			EXIT_ABORTED,
		);
	}, 10_000);

	it("is reached from a second copy of this module", async () => {
		// A consumer and a provider package each install their own copy
		// of this library, so the call is set in one and the command is
		// started in the other.
		const exec = spawnExec();
		vi.resetModules();
		const other = await import("../../../lib/core/exec/call-signal.ts");
		const stop = new AbortController();
		const running = other.withCallSignal(stop.signal, () =>
			exec("sleep", ["30"]),
		);
		setTimeout(() => stop.abort(), 50);

		const result = await within(running);
		expect(result === "still running" ? result : result.code).toBe(
			EXIT_ABORTED,
		);
	}, 10_000);
});

/** A promise that settles when the test says, and the way to say it. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open = (): void => undefined;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

describe("work a call left behind", () => {
	// A call's continuations keep its context after it ends: a listener
	// it registered, or a promise it chained and never awaited. Once the
	// call is over, its signal firing is no reason to stop their work.
	it("runs its command after the call returned and its signal fired", async () => {
		const exec = spawnExec();
		const stop = new AbortController();
		const later = gate();
		let leftover: Promise<ExecResult> | undefined;
		await withCallSignal(stop.signal, async () => {
			leftover = later.opened.then(() => exec("sh", ["-c", "echo done"]));
		});
		stop.abort();
		later.open();

		const result = await leftover;
		expect(result?.code).toBe(0);
		expect(result?.stdout.trim()).toBe("done");
	});

	it("reads no signal once the call returned", async () => {
		const stop = new AbortController();
		const later = gate();
		let during: AbortSignal | undefined;
		let after: Promise<AbortSignal | undefined> | undefined;
		await withCallSignal(stop.signal, async () => {
			during = callSignal();
			after = later.opened.then(() => callSignal());
		});
		later.open();

		expect(during).toBe(stop.signal);
		expect(await after).toBeUndefined();
	});

	it("reads no signal once a call that returned at once is over", async () => {
		const stop = new AbortController();
		const later = gate();
		let after: Promise<AbortSignal | undefined> | undefined;
		withCallSignal(stop.signal, () => {
			after = later.opened.then(() => callSignal());
		});
		later.open();

		expect(await after).toBeUndefined();
	});

	it("reads no signal once a call that failed is over", async () => {
		const stop = new AbortController();
		const later = gate();
		let after: Promise<AbortSignal | undefined> | undefined;
		const failed = withCallSignal(stop.signal, async () => {
			after = later.opened.then(() => callSignal());
			throw new Error("the call failed");
		});
		await expect(failed).rejects.toThrow("the call failed");
		later.open();

		expect(await after).toBeUndefined();
	});

	it("reads no signal in a second copy of this module either", async () => {
		vi.resetModules();
		const other = await import("../../../lib/core/exec/call-signal.ts");
		const stop = new AbortController();
		const later = gate();
		let after: Promise<AbortSignal | undefined> | undefined;
		await other.withCallSignal(stop.signal, async () => {
			after = later.opened.then(() => callSignal());
		});
		later.open();

		expect(await after).toBeUndefined();
	});

	it("leaves a call still running its signal", async () => {
		const stop = new AbortController();
		const later = gate();
		const running = withCallSignal(stop.signal, async () => {
			await later.opened;
			return callSignal();
		});
		later.open();

		expect(await running).toBe(stop.signal);
	});
});

describe("a command started outside any call", () => {
	it("runs to its end", async () => {
		const stop = new AbortController();
		withCallSignal(stop.signal, () => undefined);
		stop.abort();

		const result = await spawnExec()("sh", ["-c", "echo done"]);
		expect(result.stdout.trim()).toBe("done");
	});
});
