/** A start asked again under its id is answered as the first was. */
import { describe, expect, it, vi } from "vitest";
import { REPEAT_WINDOW_MS, repeats } from "../../../host/service/repeats.ts";
import { STAGE_VARIABLE } from "../../../lib/internal/fence/fence-stage.ts";
import { SANDBOX_VARIABLE } from "../../../lib/internal/sandbox/sandbox.ts";

const asked = { v: 1, id: "a1", op: "open", cwd: "/work", attended: false };

/** A start the test settles by hand, counting how often it was begun. */
function pending() {
	let settle: (value: unknown) => void = () => undefined;
	let fail: (error: unknown) => void = () => undefined;
	const start = vi.fn(
		() =>
			new Promise<unknown>((resolve, reject) => {
				settle = resolve;
				fail = reject;
			}),
	);
	return {
		start,
		settle: (value: unknown) => settle(value),
		fail: (error: unknown) => fail(error),
	};
}

describe("repeats", () => {
	it("answers a repeat that comes while the first is under way with the first's answer", async () => {
		const memory = repeats();
		const first = pending();
		const answers = [
			memory.answer(asked, first.start),
			memory.answer({ ...asked }, first.start),
		];
		first.settle({ sessionId: "s1" });
		expect(await Promise.all(answers)).toEqual([
			{ sessionId: "s1" },
			{ sessionId: "s1" },
		]);
		expect(first.start).toHaveBeenCalledOnce();
	});

	it("answers a repeat within its window as the first was, and starts anew once the window has passed", async () => {
		let now = 0;
		const memory = repeats(() => now);
		const start = vi.fn(async () => ({ sessionId: `s${start.mock.calls.length}` }));
		expect(await memory.answer(asked, start)).toEqual({ sessionId: "s1" });
		now = REPEAT_WINDOW_MS;
		expect(await memory.answer(asked, start), "within the window").toEqual({
			sessionId: "s1",
		});
		now = REPEAT_WINDOW_MS + 1;
		expect(await memory.answer(asked, start), "past it").toEqual({
			sessionId: "s2",
		});
		expect(start).toHaveBeenCalledTimes(2);
	});

	it("keeps a start under way however long it takes, so its repeat never starts a second", async () => {
		let now = 0;
		const memory = repeats(() => now);
		const first = pending();
		const answer = memory.answer(asked, first.start);
		now = REPEAT_WINDOW_MS * 4;
		const again = memory.answer(asked, first.start);
		first.settle({ sessionId: "s1" });
		expect(await again).toEqual(await answer);
		expect(first.start).toHaveBeenCalledOnce();
	});

	it("forgets a start that failed, so asking again starts anew", async () => {
		const memory = repeats();
		const first = pending();
		const answer = memory.answer(asked, first.start);
		first.fail(new Error("extension load failed"));
		await expect(answer).rejects.toThrow("extension load failed");
		const retry = vi.fn(async () => ({ sessionId: "s2" }));
		expect(await memory.answer(asked, retry)).toEqual({ sessionId: "s2" });
		expect(retry).toHaveBeenCalledOnce();
	});

	it("refuses an id used again for another request, leaving the first's answer as it was", async () => {
		const memory = repeats();
		const start = vi.fn(async () => ({ sessionId: "s1" }));
		await memory.answer(asked, start);
		await expect(
			memory.answer({ ...asked, cwd: "/elsewhere" }, start),
		).rejects.toThrow("Request id a1 was already used for another request");
		expect(await memory.answer(asked, start)).toEqual({ sessionId: "s1" });
		expect(start).toHaveBeenCalledOnce();
	});

	it("matches a repeat whatever order its fields come in, and whichever host it expects", async () => {
		const memory = repeats();
		const start = vi.fn(async () => ({ sessionId: "s1" }));
		await memory.answer(
			{ ...asked, model: { provider: "p", id: "m" } },
			start,
		);
		const reordered = {
			model: { id: "m", provider: "p" },
			attended: false,
			cwd: "/work",
			op: "open",
			id: "a1",
			v: 1,
			expectedHost: { key: "work-background", owner: { pid: 9, startedAt: 1 } },
		};
		expect(await memory.answer(reordered, start)).toEqual({ sessionId: "s1" });
		expect(start).toHaveBeenCalledOnce();
	});

	it("starts anew for a repeat once what the first opened no longer stands", async () => {
		let standing = true;
		const memory = repeats(Date.now, REPEAT_WINDOW_MS, () => standing);
		const start = vi.fn(async () => ({ sessionId: "s1" }));
		await memory.answer(asked, start);
		await memory.answer(asked, start);
		expect(start).toHaveBeenCalledOnce();
		standing = false;
		await memory.answer(asked, start);
		expect(start).toHaveBeenCalledTimes(2);
	});

	it("answers a repeat with the first's failure while what it left behind stands", async () => {
		const left = new Error("started, then failed; held parked");
		const memory = repeats(
			Date.now,
			REPEAT_WINDOW_MS,
			(outcome) => !outcome.ok && outcome.error === left,
		);
		const start = vi.fn(async () => {
			throw left;
		});
		await expect(memory.answer(asked, start)).rejects.toBe(left);
		await expect(memory.answer(asked, start)).rejects.toBe(left);
		expect(start).toHaveBeenCalledOnce();
	});

	it("matches a repeat carrying a fresh stage token, but not one carrying another fence", async () => {
		const memory = repeats();
		const start = vi.fn(async () => ({ sessionId: "s1" }));
		const first = { ...asked, env: { [STAGE_VARIABLE]: "token-1" } };
		await memory.answer(first, start);
		const restaged = { ...asked, env: { [STAGE_VARIABLE]: "token-2" } };
		expect(await memory.answer(restaged, start)).toEqual({ sessionId: "s1" });
		expect(start).toHaveBeenCalledOnce();
		const refenced = {
			...asked,
			env: { [STAGE_VARIABLE]: "token-3", [SANDBOX_VARIABLE]: "off" },
		};
		await expect(memory.answer(refenced, start)).rejects.toThrow(/already used/);
	});
});
