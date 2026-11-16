/** Parking a conversation: a park under way can be waited on, and a wake says how it went. */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARKED, parking } from "../../../host/engine/parking.ts";
import { askWake, writeParked } from "../../../lib/internal/session/park.ts";
import { readRefusedWake } from "../../../lib/internal/session/refused-wake.ts";
import { giveSteer, inboxOf } from "../../../lib/mesh/steer.ts";
import { quietFor, until } from "../../support/until.ts";

/** How long a refusal may take to be kept, inside the case's own 5 s, so a red names this wait. */
const KEPT_WITHIN_MS = 2000;

/** The longest a waking steer may wait for its wake, from landing to asked. */
const STEER_WAKES_WITHIN_MS = 100;

/** The address the parked conversation `a` answers to. */
const ADDRESS = "A1B2C3";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "parking-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * Parking whose stop waits until let go, and whose wake is `asking`;
 * `a` answers to ADDRESS, with its steer inboxes under `steers`.
 */
function held(
	asking: (sessionId: string) => Promise<void>,
	holding?: () => boolean,
) {
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
		steers: {
			root: steers(),
			addressesOf: (sessionId) => (sessionId === "a" ? [ADDRESS] : []),
		},
		...(holding ? { holding } : {}),
	});
	return { parked, stop, report, letStop: () => stopped?.() };
}

/** Where the person's steers wait, one inbox an address. */
function steers(): string {
	return join(dir, "steer");
}

/** Park `a` in parking whose wake is `asking`, once its stop settles. */
async function parkedWith(asking: (sessionId: string) => Promise<void>) {
	const made = held(asking);
	const parking = made.parked.park("a");
	made.letStop();
	await parking;
	return made;
}

/** A wake that notes when it was asked, on the clock steers land by. */
function timedWake() {
	const asked: number[] = [];
	const asking = vi.fn((_sessionId: string) => {
		asked.push(performance.now());
		return Promise.resolve();
	});
	return { asking, asked };
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
		const woke = parked.wake("a", "other");
		await until("the park to stop it", () => stop.mock.calls.length > 0);
		expect(stop, "it stops as a park").toHaveBeenCalledWith("a", PARKED);
		expect(settled, "unsettled while it stops").toBe(false);
		expect(asking, "no wake while it parks").not.toHaveBeenCalled();
		letStop();
		await parking;
		await settling;
		await woke;

		expect(asking, "woken once parked").toHaveBeenCalledExactlyOnceWith(
			"a",
			"other",
		);
		await expect(
			parked.settled("a"),
			"settled at once with no park under way",
		).resolves.toBeUndefined();
	});

	it("wakes as a window once parked, when a window asked among others while it parked", async () => {
		const asking = vi.fn(() => Promise.resolve());
		const { parked, letStop } = held(asking);

		const parking = parked.park("a");
		const byWindow = parked.wake("a", "window");
		const byMessage = parked.wake("a", "other");
		letStop();
		await parking;
		await Promise.all([byWindow, byMessage]);

		expect(
			asking,
			"one wake, as the window asked, whichever asked last",
		).toHaveBeenCalledExactlyOnceWith("a", "window");
		parked.unwatch("a");
	});

	it("rejects a wake that failed, with why, both alone and asked while it parked", async () => {
		const refused = new Error("the rollout gate said no");
		const { parked, stop, report, letStop } = held(() =>
			Promise.reject(refused),
		);

		await expect(parked.wake("a", "other"), "a wake alone").rejects.toBe(
			refused,
		);
		const parking = parked.park("a");
		const woke = parked.wake("a", "other");
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
		expect(asking, "it was woken").toHaveBeenCalledWith("a", "other");
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

	it("wakes within 100 ms of a talk landing in an inbox made after it parked", async () => {
		const { asking, asked } = timedWake();
		const { parked } = await parkedWith(asking);

		const landed = performance.now();
		giveSteer(steers(), ADDRESS, { text: "are you there?", from: "joel" });

		await until("the talk to wake it", () => asked.length > 0);
		expect(asking, "woken for its talk").toHaveBeenCalledWith("a", "other");
		expect(
			(asked[0] ?? Number.POSITIVE_INFINITY) - landed,
			"steer landed to wake asked, in ms",
		).toBeLessThan(STEER_WAKES_WITHIN_MS);
		parked.unwatch("a");
	});

	it("wakes for each act only a running session can make, landing in an inbox already there", async () => {
		const { asking, asked } = timedWake();
		await mkdir(inboxOf(steers(), ADDRESS), { recursive: true });
		const { parked } = await parkedWith(asking);

		const landed = performance.now();
		giveSteer(steers(), ADDRESS, { text: "", act: "close", from: "joel" });

		await until("the close to wake it", () => asked.length > 0);
		expect(
			(asked[0] ?? Number.POSITIVE_INFINITY) - landed,
			"steer landed to wake asked, in ms",
		).toBeLessThan(STEER_WAKES_WITHIN_MS);
		parked.unwatch("a");
	});

	it("wakes one resting from an earlier host for a talk left while the host was down", async () => {
		const { asking, asked } = timedWake();
		const { parked } = held(asking);
		giveSteer(steers(), ADDRESS, { text: "while you slept", from: "joel" });

		parked.rests("a");

		await until("the talk left before to wake it", () => asked.length > 0);
		parked.unwatch("a");
	});

	it("leaves a pause, and a talk to another address, waiting for its next start", async () => {
		const { asking } = timedWake();
		const { parked } = await parkedWith(asking);

		giveSteer(steers(), ADDRESS, { text: "", act: "pause", from: "joel" });
		giveSteer(steers(), "Z9Y8X7", { text: "not for a", from: "joel" });
		await quietFor(STEER_WAKES_WITHIN_MS, 3);

		expect(asking, "nothing it waits on running asked").not.toHaveBeenCalled();
		parked.unwatch("a");
	});

	it("wakes again for a talk once its inbox was swept and made again", async () => {
		const { asking, asked } = timedWake();
		const inbox = inboxOf(steers(), ADDRESS);
		await mkdir(inbox, { recursive: true });
		const { parked } = await parkedWith(asking);

		// forgetInboxes sweeps an inbox quiet long enough, folder and all.
		await rm(inbox, { recursive: true, force: true });
		await quietFor(STEER_WAKES_WITHIN_MS, 1);
		const landed = performance.now();
		giveSteer(steers(), ADDRESS, { text: "back again", from: "joel" });

		await until("the talk to wake it", () => asked.length > 0);
		expect(
			(asked[0] ?? Number.POSITIVE_INFINITY) - landed,
			"steer landed to wake asked, in ms",
		).toBeLessThan(STEER_WAKES_WITHIN_MS);
		parked.unwatch("a");
	});

	it("asks once a steer, however often its inbox stirs", async () => {
		const { asking, asked } = timedWake();
		const { parked } = await parkedWith(asking);

		giveSteer(steers(), ADDRESS, { text: "one", from: "joel" });
		await until("the talk to wake it", () => asked.length > 0);
		giveSteer(steers(), ADDRESS, { text: "", act: "pause", from: "joel" });
		await quietFor(STEER_WAKES_WITHIN_MS, 3);

		expect(asking, "one talk, one wake").toHaveBeenCalledTimes(1);
		parked.unwatch("a");
	});

	it("watches its inbox no more once it resumes or is closed", async () => {
		const { asking } = timedWake();
		const { parked } = await parkedWith(asking);
		parked.unwatch("a");
		giveSteer(steers(), ADDRESS, { text: "after it woke", from: "joel" });
		await quietFor(STEER_WAKES_WITHIN_MS, 3);
		expect(asking, "nothing asked once it resumed").not.toHaveBeenCalled();

		// It took the steer as it started, so its next park finds none waiting.
		await rm(inboxOf(steers(), ADDRESS), { recursive: true, force: true });
		const again = await parkedWith(asking);
		again.parked.closed("a");
		giveSteer(steers(), ADDRESS, { text: "after it closed", from: "joel" });
		await quietFor(STEER_WAKES_WITHIN_MS, 3);
		expect(asking, "nothing asked once it closed").not.toHaveBeenCalled();
	});

	it("keeps a refused steer's wake beside its wake file, naming the steer", async () => {
		const { parked } = await parkedWith(() =>
			Promise.reject(new Error("the host is stopping")),
		);
		const file = giveSteer(steers(), ADDRESS, {
			text: "are you there?",
			from: "joel",
		});
		const wake = parked.wakeFile("a");

		await until(
			"the refused wake to be kept",
			() => readRefusedWake(wake) !== undefined,
			KEPT_WITHIN_MS,
		);
		expect(
			readRefusedWake(wake),
			"the steer that asked, and why not",
		).toMatchObject({
			messageId: `steer-${file}`,
			reason: "the host is stopping",
		});
		parked.closed("a");
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

// 16 November: the background host's conversations took turns that
// overlapped for over an hour, so a restart found no moment with none
// running; a drain parks them, and a parked one woken would run again.
describe("parking while the host drains", () => {
	it("leaves a wake written to its file on disk, and wakes it once the drain lifts", async () => {
		let draining = true;
		const { asking, asked } = timedWake();
		const { parked, letStop } = held(asking, () => draining);
		const parking = parked.park("a");
		letStop();
		await parking;
		const wake = parked.wakeFile("a");

		wakeAsTheMeshDoes(wake);
		await quietFor(STEER_WAKES_WITHIN_MS, 3);
		expect(asked, "no wake while it drains").toEqual([]);
		expect(existsSync(wake), "the wake stays for the next host").toBe(true);

		draining = false;
		parked.release();
		await until("the lifted drain to wake it", () => asked.length > 0);
		expect(asking, "woken once").toHaveBeenCalledExactlyOnceWith("a", "other");
		parked.unwatch("a");
	});

	it("holds a steer that would wake it, and asks it once the drain lifts", async () => {
		let draining = true;
		const { asking, asked } = timedWake();
		const { parked, letStop } = held(asking, () => draining);
		const parking = parked.park("a");
		letStop();
		await parking;

		giveSteer(steers(), ADDRESS, { text: "are you there?", from: "joel" });
		await quietFor(STEER_WAKES_WITHIN_MS, 3);
		expect(asked, "no wake while it drains").toEqual([]);

		draining = false;
		parked.release();
		await until("the lifted drain to wake it", () => asked.length > 0);
		expect(asking, "woken once").toHaveBeenCalledExactlyOnceWith("a", "other");
		parked.unwatch("a");
	});

	it("still wakes one asked for directly, as a window opening or a viewer typing does", async () => {
		const asking = vi.fn(() => Promise.resolve());
		const { parked, letStop } = held(asking, () => true);
		const parking = parked.park("a");
		letStop();
		await parking;

		await parked.wake("a", "window");

		expect(asking, "a window's wake is never held").toHaveBeenCalledWith(
			"a",
			"window",
		);
		parked.unwatch("a");
	});
});
