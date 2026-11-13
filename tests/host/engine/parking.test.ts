/** Parking a conversation: a park under way can be waited on, and a wake says how it went. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARKED, parking } from "../../../host/engine/parking.ts";
import { askWake, writeParked } from "../../../lib/internal/session/park.ts";
import { readRefusedWake } from "../../../lib/internal/session/refused-wake.ts";
import { until } from "../../support/until.ts";

/** How long a refusal may take to be kept, inside the case's own 5 s, so a red names this wait. */
const KEPT_WITHIN_MS = 2000;

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

/**
 * Park `a` in parking whose wakes are refused as a stopping host's are,
 * then wake it as the mesh does, through the wake file its marker names,
 * answering that file once the refusal is kept beside it.
 */
async function refusedOnce(): Promise<{
	parked: ReturnType<typeof held>["parked"];
	wake: string;
}> {
	const { parked, letStop } = held(() =>
		Promise.reject(new Error("the host is stopping")),
	);
	const parking = parked.park("a");
	letStop();
	await parking;
	const wake = parked.wakeFile("a");
	wakeAsTheMeshDoes(wake);
	await until(
		"the refused wake to be kept",
		() => readRefusedWake(wake) !== undefined,
		KEPT_WITHIN_MS,
	);
	return { parked, wake };
}

/** Wake `a` as a mesh sender does: through the wake file its park marker names. */
function wakeAsTheMeshDoes(wake: string): void {
	const parks = join(dir, "parks");
	writeParked(
		{
			session: "a",
			sessionFile: join(dir, "a.jsonl"),
			cwd: dir,
			addresses: ["A1B2C3"],
			parkedAt: new Date().toISOString(),
			pid: process.pid,
			wake,
		},
		parks,
	);
	expect(askWake("a", "2f95756a", parks), "the sender asked").toBe(true);
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

	it("watches the wake of one parked under an earlier host, waking it for one written before", async () => {
		const asking = vi.fn((_sessionId: string) => Promise.resolve());
		const { parked, stop } = held(asking);
		const woke = (sessionId: string) =>
			asking.mock.calls.some(([id]) => id === sessionId);
		await mkdir(join(dir, "a"), { recursive: true });
		await writeFile(parked.wakeFile("a"), "sent while the host was down");

		parked.rests("a");
		parked.rests("b");

		await until("the wake written before to wake it", () => woke("a"));
		expect(woke("b"), "one with no wake written rests").toBe(false);
		await writeFile(parked.wakeFile("b"), "message");
		await until("the wake written after to wake it", () => woke("b"));
		expect(stop, "nothing parked again: it already was").not.toHaveBeenCalled();
		parked.unwatch("a");
		parked.unwatch("b");
	});

	it("keeps a refused wake's message and why beside its wake file, until it runs", async () => {
		const { parked, wake } = await refusedOnce();

		expect(readRefusedWake(wake), "what asked, and why not").toMatchObject({
			messageId: "2f95756a",
			reason: "the host is stopping",
		});
		parked.running("a");
		expect(readRefusedWake(wake), "gone once it runs").toBeUndefined();
		parked.unwatch("a");
	});

	it("forgets a refused wake once the conversation is closed", async () => {
		const { parked, wake } = await refusedOnce();

		parked.closed("a");

		expect(
			readRefusedWake(wake),
			"no refusal outlives the conversation's close",
		).toBeUndefined();
	});

	it("keeps no refusal that settles after the conversation is closed", async () => {
		let refuse: ((error: Error) => void) | undefined;
		const asking = vi.fn(
			() =>
				new Promise<void>((_, reject) => {
					refuse = reject;
				}),
		);
		const { parked, report, letStop } = held(asking);
		const parking = parked.park("a");
		letStop();
		await parking;
		const wake = parked.wakeFile("a");
		wakeAsTheMeshDoes(wake);
		await until("the wake to be asked", () => asking.mock.calls.length > 0);

		parked.closed("a");
		refuse?.(new Error("the host is stopping"));
		await until(
			"the refusal to be reported",
			() => report.mock.calls.length > 0,
		);
		// The refusal is kept, or not, in the turn after it is reported.
		await new Promise(setImmediate);

		expect(
			readRefusedWake(wake),
			"a refusal settling after the close is not kept",
		).toBeUndefined();
	});

	it("keeps no refusal that settles as the conversation starts again", async () => {
		let refuse: ((error: Error) => void) | undefined;
		const asking = vi.fn(
			() =>
				new Promise<void>((_, reject) => {
					refuse = reject;
				}),
		);
		const { parked, report, letStop } = held(asking);
		const parking = parked.park("a");
		letStop();
		await parking;
		const wake = parked.wakeFile("a");
		wakeAsTheMeshDoes(wake);
		await until("the wake to be asked", () => asking.mock.calls.length > 0);

		// The engine says it runs as it begins, and unwatches once begun.
		parked.running("a");
		refuse?.(new Error("the host is stopping"));
		await until(
			"the refusal to be reported",
			() => report.mock.calls.length > 0,
		);
		// The refusal is kept, or not, in the turn after it is reported.
		await new Promise(setImmediate);
		parked.unwatch("a");

		expect(
			readRefusedWake(wake),
			"a refusal settling as it starts is not kept once it runs",
		).toBeUndefined();
	});
});
