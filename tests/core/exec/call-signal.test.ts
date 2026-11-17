/**
 * A command stops with the call that started it.
 *
 * A review provider is built once and runs its commands through an
 * exec handed to it then, so nothing about one tool call can reach
 * the command that call makes: a gs or gh run went on to its clock
 * whatever Escape said. The call's signal travels with the call
 * instead, and a command started inside it stops when it fires.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import {
	callSignal,
	withCallSignal,
} from "../../../lib/core/exec/call-signal.ts";
import type { ExecResult } from "../../../lib/core/exec/exec.ts";
import { EXIT_ABORTED, spawnExec } from "../../../lib/core/exec/spawn.ts";

/** The store an older copy of this module keeps signals in, made first if no call has. */
function olderCopysStore(): AsyncLocalStorage<AbortSignal | undefined> {
	withCallSignal(undefined, () => undefined);
	const first: unknown = Reflect.get(
		globalThis,
		Symbol.for("agentic-harness.core/exec/call-signal"),
	);
	if (!(first instanceof AsyncLocalStorage))
		throw new Error("the first store was never made");
	return first;
}

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

	it("reads no signal once a call that threw as it was made is over", async () => {
		const stop = new AbortController();
		const later = gate();
		let after: Promise<AbortSignal | undefined> | undefined;
		expect(() =>
			withCallSignal(stop.signal, () => {
				after = later.opened.then(() => callSignal());
				throw new Error("the call threw");
			}),
		).toThrow("the call threw");
		later.open();

		expect(await after).toBeUndefined();
	});

	it("reads no signal in a timer the call set", async () => {
		const stop = new AbortController();
		let after: Promise<AbortSignal | undefined> | undefined;
		await withCallSignal(stop.signal, async () => {
			after = new Promise((resolve) =>
				setTimeout(() => resolve(callSignal()), 20),
			);
		});
		stop.abort();

		expect(await after).toBeUndefined();
	});

	it("reads the call it was made inside while that one still runs", async () => {
		const outer = new AbortController();
		const inner = new AbortController();
		const later = gate();
		const outerDone = gate();
		let whileOuter: Promise<AbortSignal | undefined> | undefined;
		let afterBoth: Promise<AbortSignal | undefined> | undefined;
		const running = withCallSignal(outer.signal, async () => {
			await withCallSignal(inner.signal, async () => {
				whileOuter = later.opened.then(() => callSignal());
				afterBoth = outerDone.opened.then(() => callSignal());
			});
			later.open();
			await whileOuter;
		});
		await running;
		outerDone.open();

		expect(await whileOuter, "the outer call still ran").toBe(outer.signal);
		expect(await afterBoth, "both calls are over").toBeUndefined();
	});

	it("reads a signal an older copy set inside a call that is over", async () => {
		// An older copy keeps only the first store, so it marks no call.
		const first: unknown = Reflect.get(
			globalThis,
			Symbol.for("agentic-harness.core/exec/call-signal"),
		);
		if (!(first instanceof AsyncLocalStorage))
			throw new Error("the first store was never made");
		const stop = new AbortController();
		const older = new AbortController();
		const later = gate();
		let after: Promise<AbortSignal | undefined> | undefined;
		await withCallSignal(stop.signal, async () => {
			after = later.opened.then(() =>
				first.run(older.signal, () => callSignal()),
			);
		});
		later.open();

		expect(await after).toBe(older.signal);
	});

	it("runs its command under a fired signal an older copy left, as its call's end", async () => {
		// What an older copy leaves a session's context holding lasts past a
		// reload onto this one; read as its own, every git the work tool ran
		// failed as aborted before it started until the session restarted
		// (FEH1HE, 17 November).
		const first = olderCopysStore();
		const older = new AbortController();
		older.abort();
		const outer = new AbortController();

		const ran = await first.run(older.signal, () => spawnExec()("true", []));
		const alone = first.run(older.signal, () => callSignal());
		const inside = await withCallSignal(outer.signal, async () =>
			first.run(older.signal, () => callSignal()),
		);

		expect(ran.code, "the command ran").toBe(0);
		expect(alone, "left outside any call reads none").toBeUndefined();
		expect(inside, "left inside a call still running reads that call's").toBe(
			outer.signal,
		);
	});

	it("reads an older copy's signal only while it is live, which it can't say ended", () => {
		// The cost of the case above, taken knowingly: an older copy's call
		// still running loses Escape for commands begun after it fires, as no
		// package but this one wraps calls, and a leak stopped every command.
		const first = olderCopysStore();
		const older = new AbortController();

		const live = first.run(older.signal, () => callSignal());
		older.abort();
		const fired = first.run(older.signal, () => callSignal());

		expect(live, "still live").toBe(older.signal);
		expect(fired, "fired, with no call to say it still runs").toBeUndefined();
	});

	it("stops a command begun after its own call's signal fired, while that call runs", async () => {
		const stop = new AbortController();

		const result = await withCallSignal(stop.signal, async () => {
			stop.abort();
			return {
				read: callSignal(),
				ran: await spawnExec()("true", []),
			};
		});

		expect(result.read, "the call's own signal").toBe(stop.signal);
		expect(result.ran.code, "aborted before it started").toBe(EXIT_ABORTED);
	});

	it("rejects as the call did, with the promise it hands back", async () => {
		const failed = withCallSignal(undefined, async () => {
			throw new Error("the call failed");
		});

		await expect(failed).rejects.toThrow("the call failed");
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
