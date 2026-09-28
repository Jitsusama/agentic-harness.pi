/**
 * There is one screen, so there is one gate on it at a time.
 *
 * Pi's `ctx.ui.custom` supports one active component. When an agent fires
 * several write calls in one turn their handlers run concurrently and each
 * tries to mount its own gate: the first wins the UI and the rest either
 * hang or silently bypass review, which is the bad one, because a gate
 * nobody saw still counts as approval.
 *
 * These tests came from slack-integration, where the queue used to live
 * privately. They moved with the code rather than being rewritten: the
 * ordering contract is the same contract, and it is now the whole
 * package's rather than one integration's.
 *
 * They drive the queue with deferred promises so the contract is locked in
 * without booting a TUI.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { runGate } from "../../../lib/ui/gate-queue.ts";

/**
 * Where every copy of `lib/ui` looks for the queue. Spelled out rather
 * than imported, because the string is the contract between copies at
 * different versions: renaming it in the module would split the screen
 * between two queues while every test that imported it stayed green.
 */
const QUEUE_KEY = Symbol.for("agentic-harness.gate-queue");

/** Let every settled promise run its handlers. */
async function drain(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

function defer<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("taking the screen one gate at a time", () => {
	it("runs concurrent gates serially in arrival order", async () => {
		const order: string[] = [];

		const first = defer<string>();
		const second = defer<string>();
		const third = defer<string>();

		const a = runGate(async () => {
			order.push("a:start");
			const value = await first.promise;
			order.push("a:end");
			return value;
		});
		const b = runGate(async () => {
			order.push("b:start");
			const value = await second.promise;
			order.push("b:end");
			return value;
		});
		const c = runGate(async () => {
			order.push("c:start");
			const value = await third.promise;
			order.push("c:end");
			return value;
		});

		// Only the first gate should have started; the others wait.
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["a:start"]);

		first.resolve("a");
		expect(await a).toBe("a");

		// Now b is unblocked, c still waiting.
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["a:start", "a:end", "b:start"]);

		second.resolve("b");
		expect(await b).toBe("b");

		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start"]);

		third.resolve("c");
		expect(await c).toBe("c");
		expect(order).toEqual([
			"a:start",
			"a:end",
			"b:start",
			"b:end",
			"c:start",
			"c:end",
		]);
	});

	it("does not let one gate's rejection poison the queue", async () => {
		const order: string[] = [];

		const failing = runGate(async () => {
			order.push("fail:start");
			throw new Error("boom");
		});

		const next = runGate(async () => {
			order.push("next:start");
			return "ok";
		});

		await expect(failing).rejects.toThrow("boom");
		await expect(next).resolves.toBe("ok");
		expect(order).toEqual(["fail:start", "next:start"]);
	});

	it("queues gates added while another is in flight", async () => {
		const order: string[] = [];
		const gate = defer<void>();

		const first = runGate(async () => {
			order.push("first:start");
			await gate.promise;
			order.push("first:end");
		});

		// Second caller arrives after the first started its work but
		// before it settles. It should still wait.
		await Promise.resolve();
		const second = runGate(async () => {
			order.push("second:start");
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["first:start"]);

		gate.resolve();
		await first;
		await second;
		expect(order).toEqual(["first:start", "first:end", "second:start"]);
	});
});

describe("leaving the queue", () => {
	it("lets a gate stopped while it waits leave at once, without mounting", async () => {
		// Escape on a turn whose gate is queued behind another used to do
		// nothing until the gate ahead was answered, and then mounted a
		// panel for a call that had already been stopped.
		const ahead = defer<string>();
		const holding = runGate(() => ahead.promise);
		const controller = new AbortController();
		let mounted = false;
		const waiting = runGate(
			async () => {
				mounted = true;
			},
			{ signal: controller.signal },
		);
		const behind = runGate(async () => "behind");

		controller.abort();
		const outcome = await Promise.race([
			waiting.then(
				() => "resolved",
				(err: Error) => err.name,
			),
			new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
		]);
		expect(outcome).toBe("AbortError");

		ahead.resolve("ahead");
		expect(await holding).toBe("ahead");
		expect(await behind).toBe("behind");
		expect(mounted).toBe(false);
	});

	it("never mounts a gate whose signal was stopped already", async () => {
		let mounted = false;
		await expect(
			runGate(
				async () => {
					mounted = true;
				},
				{ signal: AbortSignal.abort() },
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(mounted).toBe(false);
	});

	it("keeps the screen for a mounted gate until its panel is gone", async () => {
		// A mounted gate closes itself on abort; letting the next one mount
		// before it has would put two panels up at once.
		const order: string[] = [];
		const controller = new AbortController();
		const closing = defer<void>();
		const mountedGate = runGate(
			async () => {
				order.push("first:up");
				await closing.promise;
				order.push("first:gone");
			},
			{ signal: controller.signal },
		);
		const next = runGate(async () => {
			order.push("next:up");
		});
		await drain();
		controller.abort();
		await drain();
		expect(order).toEqual(["first:up"]);

		closing.resolve();
		await mountedGate;
		await next;
		expect(order).toEqual(["first:up", "first:gone", "next:up"]);
	});

	it("lets a holder hand the screen back before its work settles", async () => {
		// A panel pi dropped without settling its promise would hold the
		// queue for good. Whoever sees the panel go releases the hold.
		const order: string[] = [];
		const never = defer<string>();
		const stuck = runGate(async (hold) => {
			order.push("stuck:up");
			hold.release();
			return never.promise;
		});
		const next = runGate(async () => {
			order.push("next:up");
			return "next";
		});

		expect(await next).toBe("next");
		expect(order).toEqual(["stuck:up", "next:up"]);

		// Its caller still gets its answer when it comes.
		never.resolve("late");
		expect(await stuck).toBe("late");
	});
});

describe("a gate opened by the gate on screen", () => {
	it("runs at once rather than waiting on itself", async () => {
		// Slack and review wrap their prompts in the queue, and the
		// prompts will take it themselves; the inner call is the same
		// panel, and queueing it behind its own wrapper never returns.
		const outer = runGate(async () =>
			runGate(async () => runGate(async () => "inner")),
		);
		const outcome = await Promise.race([
			outer,
			new Promise((resolve) => setTimeout(() => resolve("deadlocked"), 50)),
		]);
		expect(outcome).toBe("inner");
	});

	it("queues like anybody once its holder has let go", async () => {
		// Work started inside a gate outlives it. Asking later, after the
		// holder released the screen, is a new arrival and must not jump
		// ahead of the gate now showing.
		const order: string[] = [];
		const later = defer<void>();
		let asked: Promise<void> | undefined;
		await runGate(async () => {
			asked = later.promise.then(() =>
				runGate(async () => {
					order.push("late:up");
				}),
			);
		});
		const showing = defer<void>();
		const current = runGate(async () => {
			order.push("current:up");
			await showing.promise;
			order.push("current:gone");
		});
		await drain();
		later.resolve();
		await drain();
		expect(order).toEqual(["current:up"]);

		showing.resolve();
		await current;
		await asked;
		expect(order).toEqual(["current:up", "current:gone", "late:up"]);
	});
});

describe("one queue for every copy of the library", () => {
	afterEach(() => {
		vi.resetModules();
	});

	it("is shared by two copies loaded separately", async () => {
		// Two packages each bundle their own `lib/ui`, and the screen is
		// still one screen.
		vi.resetModules();
		const a = await import("../../../lib/ui/gate-queue.ts");
		vi.resetModules();
		const b = await import("../../../lib/ui/gate-queue.ts");
		expect(a.runGate).not.toBe(b.runGate);

		const order: string[] = [];
		const first = defer<void>();
		const fromA = a.runGate(async () => {
			order.push("a:up");
			await first.promise;
			order.push("a:gone");
		});
		const fromB = b.runGate(async () => {
			order.push("b:up");
		});
		await drain();
		expect(order).toEqual(["a:up"]);
		first.resolve();
		await fromA;
		await fromB;
		expect(order).toEqual(["a:up", "a:gone", "b:up"]);
	});

	it("joins a queue a newer copy installed rather than replacing it", async () => {
		const g = globalThis as Record<symbol, unknown>;
		const previous = g[QUEUE_KEY];
		const calls: string[] = [];
		g[QUEUE_KEY] = {
			version: 99,
			run: (fn: (hold: { release(): void }) => Promise<unknown>) => {
				calls.push("newer");
				return fn({ release() {} });
			},
		};
		try {
			vi.resetModules();
			const copy = await import("../../../lib/ui/gate-queue.ts");
			expect(await copy.runGate(async () => "ran")).toBe("ran");
			expect(calls).toEqual(["newer"]);
			expect((g[QUEUE_KEY] as { version: number }).version).toBe(99);
		} finally {
			g[QUEUE_KEY] = previous;
		}
	});
});
