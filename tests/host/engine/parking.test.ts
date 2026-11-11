/** Parking a conversation: a park under way can be waited on, and a wake says how it went. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARKED, parking } from "../../../host/engine/parking.ts";
import { readRefusedWake } from "../../../lib/internal/session/refused-wake.ts";
import { until } from "../../support/until.ts";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "parking-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Parking whose stop waits until let go, and whose wake is `asking`. */
function held(asking: (sessionId: string) => Promise<void>) {
	let stopped: (() => void) | undefined;
	const stop = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				stopped = resolve;
			}),
	);
	const report = vi.fn();
	const parked = parking({
		stateDir: dir,
		stop,
		asking: () => asking,
		report,
	});
	return { parked, stop, report, letStop: () => stopped?.() };
}

describe("parking a conversation", () => {
	it("settles once its stop has, and wakes one asked for meanwhile only then", async () => {
		const asking = vi.fn(() => Promise.resolve());
		const { parked, stop, letStop } = held(asking);
		let settled = false;

		const parking = parked.park("a");
		const settling = parked.settled("a").then(() => {
			settled = true;
		});
		const woke = parked.wake("a");
		await until("the park to stop it", () => stop.mock.calls.length > 0);
		expect(stop, "it stops as a park").toHaveBeenCalledWith("a", PARKED);
		expect(settled, "unsettled while it stops").toBe(false);
		expect(asking, "no wake while it parks").not.toHaveBeenCalled();
		letStop();
		await parking;
		await settling;
		await woke;

		expect(asking, "woken once parked").toHaveBeenCalledExactlyOnceWith("a");
		await expect(
			parked.settled("a"),
			"settled at once with no park under way",
		).resolves.toBeUndefined();
	});

	it("rejects a wake that failed, with why, both alone and asked while it parked", async () => {
		const refused = new Error("the rollout gate said no");
		const { parked, stop, report, letStop } = held(() =>
			Promise.reject(refused),
		);

		await expect(parked.wake("a"), "a wake alone").rejects.toBe(refused);
		const parking = parked.park("a");
		const woke = parked.wake("a");
		await until("the park to stop it", () => stop.mock.calls.length > 0);
		letStop();
		await parking;

		await expect(woke, "a wake asked while it parked").rejects.toBe(refused);
		expect(report, "each failure was reported").toHaveBeenCalledWith(refused);
	});

	it("wakes at a write to its wake file once parked", async () => {
		const asking = vi.fn(() => Promise.resolve());
		const { parked, letStop } = held(asking);
		const parking = parked.park("a");
		letStop();
		await parking;

		await writeFile(parked.wakeFile("a"), "message");

		await until("the wake file to wake it", () => asking.mock.calls.length > 0);
		expect(asking, "it was woken").toHaveBeenCalledWith("a");
		parked.unwatch("a");
	});

	it("keeps a refused wake's message and why beside its wake file, until it runs", async () => {
		const { parked, letStop } = held(() =>
			Promise.reject(new Error("the host is stopping")),
		);
		const parking = parked.park("a");
		letStop();
		await parking;
		const wake = parked.wakeFile("a");

		await writeFile(
			wake,
			`${JSON.stringify({ session: "a", messageId: "2f95756a", at: "now" })}\n`,
		);

		await until(
			"to keep the refused wake",
			() => readRefusedWake(wake) !== undefined,
		);
		expect(readRefusedWake(wake), "what asked, and why not").toMatchObject({
			messageId: "2f95756a",
			reason: "the host is stopping",
		});
		parked.running("a");
		expect(readRefusedWake(wake), "gone once it runs").toBeUndefined();
		parked.unwatch("a");
	});
});
