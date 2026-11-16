/** A close or release of a conversation whose wake waits lets that wake go unresumed, gives it back if the close fails, and never takes a window's. */
import { describe, expect, it, vi } from "vitest";
import { until } from "../../support/until.ts";
import {
	attach,
	heldGate,
	NEVER_MS,
	settle,
	wakeHost,
} from "./support/wakes.ts";

const wakes = wakeHost();
const { backendWith, heldResumes, parked } = wakes;

describe("closing one whose wake waits", () => {
	it.each(["close", "release"] as const)(
		"lets go unresumed one whose wake waits for a place as a %s takes it, the queue going on",
		async (op) => {
			const { fake, begun, finish } = heldResumes();
			const backend = backendWith(fake, undefined, undefined, {
				wakePlaces: 1,
				wakeLongestMs: NEVER_MS,
			});
			const waking = await parked(backend);
			const closing = await parked(backend);
			const other = await parked(backend);

			const woken = backend.wake(waking);
			await until("the first wake to resume", () => begun.length === 1);
			const queued = [backend.wake(closing), backend.wake(other)];
			await settle();

			await expect(
				backend.execute({ v: 1, id: "c", op, sessionId: closing, by: "Joel" }),
				"it lands with the first still resuming",
			).resolves.toEqual({ sessionId: closing });
			finish(waking);
			await until("the next wake to resume", () => begun.length === 2);
			finish(other);
			await Promise.all([woken, ...queued]);

			expect(begun, "the one it took never resumed").toEqual([waking, other]);
		},
	);

	it("lets go unresumed one whose wake was still at the rollout gate as the close came", async () => {
		const { fake, begun, finish } = heldResumes();
		const { gate, hold, waits, open } = heldGate();
		const backend = backendWith(fake, gate, undefined, {
			wakePlaces: 1,
			wakeLongestMs: NEVER_MS,
		});
		const waking = await parked(backend);
		const closing = await parked(backend);

		const woken = backend.wake(waking);
		await until("the first wake to resume", () => begun.length === 1);
		hold();
		const queued = backend.wake(closing);
		await until("the closed one's wake to wait at the gate", waits);
		const closed = backend.execute({
			v: 1,
			id: "c",
			op: "close",
			sessionId: closing,
		});
		open();

		await expect(
			closed,
			"it lands with the first still resuming",
		).resolves.toEqual({ sessionId: closing });
		await queued;
		expect(begun, "the one it closed never resumed").toEqual([waking]);
		finish(waking);
		await woken;
	});

	it("asks again a wake it let go once the close fails, so the message that woke it is answered", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, {
			wakePlaces: 1,
			wakeLongestMs: NEVER_MS,
		});
		const waking = await parked(backend);
		const closing = await parked(backend);
		const full = new Error("the disk is full");
		vi.spyOn(wakes.roster, "drop").mockRejectedValueOnce(full);

		const woken = backend.wake(waking);
		await until("the first wake to resume", () => begun.length === 1);
		const queued = backend.wake(closing);
		await settle();
		await expect(
			backend.execute({ v: 1, id: "c", op: "close", sessionId: closing }),
			"the close fails",
		).rejects.toBe(full);
		finish(waking);
		await until("the wake it let go to resume", () => begun.length === 2);

		expect(begun, "the one it failed to close resumed").toEqual([
			waking,
			closing,
		]);
		finish(closing);
		await Promise.all([woken, queued]);
		expect(wakes.host.holds(closing), "it runs").toBe("idle");
	});

	it("resumes a window opened before the close came, which then closes it", async () => {
		const { fake, begun, finish } = heldResumes();
		const { gate, hold, waits, open } = heldGate();
		const backend = backendWith(fake, gate, undefined, {
			wakePlaces: 1,
			wakeLongestMs: NEVER_MS,
		});
		await parked(backend);
		const windowed = await parked(backend);

		hold();
		const attached = backend.execute(attach(windowed));
		await until("the window's wake to wait at the gate", waits);
		const closed = backend.execute({
			v: 1,
			id: "c",
			op: "close",
			sessionId: windowed,
		});
		open();
		await until("the window's wake to resume", () => begun.length === 1);
		finish(windowed);

		await expect(
			attached,
			"the window asked first, so it opens",
		).resolves.toMatchObject({ sessionId: windowed });
		await expect(closed, "then the close lands").resolves.toEqual({
			sessionId: windowed,
		});
		expect(wakes.host.holds(windowed), "it is closed").toBeUndefined();
	});
});
