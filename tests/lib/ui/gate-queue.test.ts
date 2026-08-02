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

import { describe, expect, it } from "vitest";
import { runGate } from "../../../lib/ui/gate-queue.js";

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
