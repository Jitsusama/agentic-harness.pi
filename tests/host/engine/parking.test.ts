/**
 * Parking a conversation: a park under way can be waited on, and a wake
 * says how it went. Long because parking's one contract, `parking()`,
 * holds its wakes, steers, drain and carried calls together, and each
 * case drives that one module through a real wake folder.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, watch } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PARKED,
	type Parking,
	parking,
	UNRECORDED_HOLDS_MS,
	WATCH_STARTS_MS,
} from "../../../host/engine/parking.ts";
import { askWake, writeParked } from "../../../lib/internal/session/park.ts";
import { readRefusedWake } from "../../../lib/internal/session/refused-wake.ts";
import type { CarriedShell } from "../../../lib/internal/shell/carried.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";
import { JOBS_CARRIED, type JobsCarried } from "../../../lib/jobs/host.ts";
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
 * `a` answers to ADDRESS, with its steer inboxes under `steers`. Its host
 * drains as `draining` says, holding each wake while it does unless
 * `holding` says otherwise, and a refusal is kept through `keepRefusal`
 * where given.
 */
function held(
	asking: (sessionId: string) => Promise<void>,
	draining?: () => boolean,
	holding: ((sessionId: string) => boolean) | undefined = draining,
	keepRefusal?: () => Promise<boolean>,
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
		...(draining ? { draining } : {}),
		...(keepRefusal ? { keepRefusal } : {}),
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
		const woke = parked.wake("a");
		await until("the park to stop it", () => stop.mock.calls.length > 0);
		expect(stop, "it stops as a park").toHaveBeenCalledWith("a", PARKED, false);
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

	// On 24 November a Mac's watch never heard 3 of 500 writes made in
	// its first 10 ms. A watch of a folder of its own hears nothing of
	// `a`'s, standing in for one that missed the write.
	it("wakes for a write its watch missed as it started, as a Mac's can", async () => {
		const asking = vi.fn((_sessionId: string) => Promise.resolve());
		const deaf = await mkdtemp(join(dir, "deaf-"));
		const parked = parking({
			stateDir: dir,
			stop: () => Promise.resolve(),
			asking: () => asking,
			report: vi.fn(),
			watch: () => watch(deaf, () => undefined),
		});
		await parked.park("a");
		// Written once the look as its watch began has read no file, as the
		// Mac's lost writes came: 20 ms is a tenth of WATCH_STARTS_MS.
		await new Promise((resolve) => setTimeout(resolve, 20));
		await writeFile(parked.wakeFile("a"), "message");
		expect(asking, "unheard by its watch").not.toHaveBeenCalled();

		await until(
			"the look once its watch started to wake it",
			() => asking.mock.calls.length > 0,
			WATCH_STARTS_MS + 2000,
		);
		expect(asking, "woken once").toHaveBeenCalledExactlyOnceWith("a");
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

	// A wake lands on the loop every conversation the host serves shares,
	// and on 23 November an open of one held that loop 5 s. A wake file
	// that is a pipe nobody writes for 2 s stands in for a slow disk.
	it("reads a wake off the thread, so a slow read holds nothing else up", async () => {
		const asking = vi.fn((_sessionId: string) => Promise.resolve());
		const { parked } = held(asking);
		await mkdir(join(dir, "a"), { recursive: true });
		const wake = parked.wakeFile("a");
		expect(spawnSync("mkfifo", [wake]).status, "a pipe made").toBe(0);
		const writer = spawn("sh", [
			"-c",
			'sleep 2; printf message > "$1"',
			"sh",
			wake,
		]);
		const written = new Promise((resolve) => writer.on("exit", resolve));

		const from = performance.now();
		parked.rests("a");
		// A tick of 20 ms comes back long before the pipe is written.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(
			performance.now() - from,
			"the loop went on while the wake was read",
		).toBeLessThan(1000);

		await written;
		await until("the wake to be asked", () => asking.mock.calls.length > 0);
		await quietFor(STEER_WAKES_WITHIN_MS, 3);
		expect(asking, "woken once").toHaveBeenCalledExactlyOnceWith("a");
		parked.unwatch("a");
	});

	it("wakes for a wake it can neither read nor remove, saying why", async () => {
		const asking = vi.fn((_sessionId: string) => Promise.resolve());
		const { parked, report, letStop } = held(asking);
		const parking = parked.park("a");
		letStop();
		await parking;

		// A folder where the file goes: it reads as nothing, and won't go.
		await mkdir(parked.wakeFile("a"));

		await until("the wake to be asked", () => asking.mock.calls.length > 0);
		expect(asking, "anything there wakes it").toHaveBeenCalledWith("a");
		expect(report, "why it stays").toHaveBeenCalledWith(
			expect.objectContaining({ code: expect.stringMatching(/EISDIR/) }),
		);
		parked.unwatch("a");
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

		parked.closed("a", true);

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

		parked.closed("a", true);
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
		expect(asking, "woken for its talk").toHaveBeenCalledWith("a");
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
		again.parked.closed("a", true);
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
		parked.closed("a", true);
	});

	// A refusal waits on the disk, and a steer landing meanwhile is a wake
	// of its own, not the one already answered.
	it("asks the wake of a steer landing while an earlier steer's refusal is kept", async () => {
		const asking = vi.fn(() =>
			Promise.reject(new Error("the host is stopping")),
		);
		let keep: (() => void) | undefined;
		const keepRefusal = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					keep = () => resolve(true);
				}),
		);
		const { parked, letStop } = held(asking, undefined, undefined, keepRefusal);
		const parking = parked.park("a");
		letStop();
		await parking;

		giveSteer(steers(), ADDRESS, { text: "one", from: "joel" });
		await until(
			"the first steer's refusal to be kept",
			() => keepRefusal.mock.calls.length > 0,
		);
		giveSteer(steers(), ADDRESS, { text: "two", from: "joel" });
		await until(
			"the second steer to ask its own wake",
			() => asking.mock.calls.length > 1,
			KEPT_WITHIN_MS,
		);

		keep?.();
		parked.closed("a", true);
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
		expect(asking, "woken once").toHaveBeenCalledExactlyOnceWith("a");
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
		expect(asking, "woken once").toHaveBeenCalledExactlyOnceWith("a");
		parked.unwatch("a");
	});

	// From 05:02 on 17 November 13 parked sessions sat on unread wakes for
	// hours, as background work kept the drain's restart past its ceiling.
	it("wakes one held once the restart passes its ceiling, and its next wake at once once it parks again", async () => {
		const { asking, asked } = timedWake();
		// Asked only once a wake's read lands, so it says the wake was seen.
		const holding = vi.fn((_sessionId: string) => true);
		const { parked, letStop } = held(asking, () => true, holding);
		const parkOnce = async () => {
			const parking = parked.park("a");
			letStop();
			await parking;
		};
		await parkOnce();
		const wake = parked.wakeFile("a");
		wakeAsTheMeshDoes(wake);
		await until("the wake to be held", () => holding.mock.calls.length > 0);
		await quietFor(STEER_WAKES_WITHIN_MS, 3);
		expect(asked, "held before the ceiling").toEqual([]);

		expect(parked.holds("a"), "a wake held before the ceiling").toBe(true);
		expect(parked.letThrough(true), "the one held, woken").toBe(1);
		expect(parked.holds("a"), "a wake let through past it").toBe(false);
		await until("the held wake to be asked", () => asked.length > 0);
		expect(existsSync(wake), "its wake read").toBe(false);
		expect(parked.letThrough(true), "said once a drain").toBeUndefined();

		// Woken through the drain, it parks again once idle, as a drain parks it.
		parked.running("a");
		await parkOnce();
		wakeAsTheMeshDoes(wake);
		await until("its next wake to be asked", () => asked.length > 1);
		expect(asking, "each woken at once").toHaveBeenCalledTimes(2);
		parked.unwatch("a");
	});

	it("wakes one held for a steer once the restart passes its ceiling", async () => {
		const { asking, asked } = timedWake();
		// Asked only as a wake or a steer lands, so it says the steer was
		// seen: a quiet spell alone let a slow watch see it after the ceiling.
		const holding = vi.fn((_sessionId: string) => true);
		const { parked, letStop } = held(asking, () => true, holding);
		const parking = parked.park("a");
		letStop();
		await parking;
		giveSteer(steers(), ADDRESS, { text: "are you there?", from: "joel" });
		await until("the steer to be held", () => holding.mock.calls.length > 0);
		await quietFor(STEER_WAKES_WITHIN_MS, 3);
		expect(asked, "held before the ceiling").toEqual([]);

		expect(parked.letThrough(true), "the one held, woken").toBe(1);
		await until("the held steer to wake it", () => asked.length > 0);
		expect(asking, "woken once").toHaveBeenCalledExactlyOnceWith("a");
		parked.unwatch("a");
	});

	// As the restart comes or the host stops, a wake waits for the next host.
	it("holds wakes again once told the restart waits no more, or a drain lifts and another starts", async () => {
		for (const [how, holdAgain] of [
			["told not", (parked: Parking) => parked.letThrough(false)],
			["lifted", (parked: Parking) => parked.release()],
		] as const) {
			const { asking, asked } = timedWake();
			const holding = vi.fn((_sessionId: string) => true);
			const { parked, letStop } = held(asking, () => true, holding);
			const parking = parked.park("a");
			letStop();
			await parking;
			expect(parked.letThrough(true), `${how}: none held`).toBe(0);
			holdAgain(parked);

			wakeAsTheMeshDoes(parked.wakeFile("a"));
			await until(
				`${how}: the wake to be held`,
				() => holding.mock.calls.length > 0,
			);
			await quietFor(STEER_WAKES_WITHIN_MS, 3);
			expect(asked, `${how}: held again`).toEqual([]);
			expect(parked.letThrough(true), `${how}: let through again`).toBe(1);
			await until(`${how}: the wake to be asked`, () => asked.length > 0);
			parked.unwatch("a");
		}
	});

	it("lets nothing through while the host doesn't drain, so its next drain still holds", async () => {
		let draining = false;
		const { asking, asked } = timedWake();
		const { parked, letStop } = held(asking, () => draining);
		const parking = parked.park("a");
		letStop();
		await parking;
		expect(parked.letThrough(true), "nothing held").toBeUndefined();

		draining = true;
		wakeAsTheMeshDoes(parked.wakeFile("a"));
		await quietFor(STEER_WAKES_WITHIN_MS, 3);
		expect(asked, "the drain holds it").toEqual([]);
		parked.unwatch("a");
	});

	// 23 November: a stale child holds the wake of one no window views, so
	// it starts on current code, and wakes one a window keeps it running for.
	it("holds only the wakes its host holds for that conversation", async () => {
		const { asking, asked } = timedWake();
		const holding = vi.fn((sessionId: string) => sessionId !== "a");
		const { parked, letStop } = held(asking, () => false, holding);
		const parking = parked.park("a");
		letStop();
		await parking;
		expect(
			{ a: parked.holds("a"), b: parked.holds("b") },
			"as its host says of each",
		).toEqual({ a: false, b: true });

		wakeAsTheMeshDoes(parked.wakeFile("a"));
		await until("its wake, held for another only", () => asked.length > 0);
		expect(holding, "asked of it by name").toHaveBeenCalledWith("a");
		parked.unwatch("a");
	});

	// A roll waits for the child to end, never for a gap a ceiling stands for.
	it("lets no held wake through while its host holds it with no drain", async () => {
		const { asking, asked } = timedWake();
		const { parked, letStop } = held(
			asking,
			() => false,
			() => true,
		);
		const parking = parked.park("a");
		letStop();
		await parking;
		const wake = parked.wakeFile("a");
		wakeAsTheMeshDoes(wake);

		expect(parked.letThrough(true), "no drain to pass").toBeUndefined();
		expect(parked.holds("a"), "still held").toBe(true);
		await quietFor(STEER_WAKES_WITHIN_MS, 3);
		expect(asked, "held for the next start").toEqual([]);
		expect(existsSync(wake), "its wake left for it").toBe(true);
		parked.unwatch("a");
	});

	it("still wakes one asked for directly, as a window opening or a viewer typing does", async () => {
		const asking = vi.fn(() => Promise.resolve());
		const { parked, letStop } = held(asking, () => true);
		const parking = parked.park("a");
		letStop();
		await parking;

		await parked.wake("a");

		expect(asking, "a window's wake is never held").toHaveBeenCalledWith("a");
		parked.unwatch("a");
	});
});

/** How often a test's parking looks at the calls a park carried. */
const CALLS_LOOKED_AT_MS = 10;

/** A bash call carried from `a`, its kept files under `dir`. */
function call(name: string): CarriedShell {
	return {
		kind: "shell",
		keep: join(dir, name),
		// No such pid: a close for good over it must kill nothing (#1981 F77).
		pid: 2 ** 22 + 1,
		mark: `mark-${name}`,
		startedAt: 0,
	};
}

/**
 * Parking whose host keeps carried calls (unless `keeps` says not), whose
 * stop, carrying, tells `bus` the calls it carried as a conversation
 * told of a restart does, and whose calls run while their keep is in
 * `runs`. `asking` answers each wake; `beforeCarry` runs in the stop.
 */
function carrying(
	calls: readonly CarriedShell[],
	runs: Set<string>,
	keeps = true,
	more: {
		asking?: (sessionId: string) => Promise<void>;
		beforeCarry?: () => void;
		/** Runs in the stop once the carry is told, as a stop failing late. */
		afterCarry?: () => void;
		wakeAgainMs?: number;
		holding?: () => boolean;
		now?: () => number;
	} = {},
) {
	const bus = createEventBus();
	const asking = vi.fn(
		more.asking ?? ((_sessionId: string) => Promise.resolve()),
	);
	const said: string[] = [];
	const stop = vi.fn(
		async (_sessionId: string, _why: string, carry: boolean) => {
			// A stop that doesn't carry cuts the calls off, saying nothing.
			if (!carry) return;
			more.beforeCarry?.();
			const carried: JobsCarried = {
				session: "a",
				jobs: calls.map((work, at) => ({
					id: `j${at + 1}`,
					kind: "shell",
					label: `until grep -q rc= ${work.keep}`,
					work,
				})),
			};
			bus.emit(JOBS_CARRIED, carried);
			more.afterCarry?.();
		},
	);
	const parked = parking({
		stateDir: dir,
		stop,
		asking: () => asking,
		report: vi.fn(),
		...(more.holding ? { holding: more.holding } : {}),
		...(more.now ? { now: more.now } : {}),
		carries: () => keeps,
		callRuns: (work) => runs.has(work.keep),
		lookEveryMs: CALLS_LOOKED_AT_MS,
		...(more.wakeAgainMs === undefined
			? {}
			: { wakeAgainMs: more.wakeAgainMs }),
		said: (line) => said.push(line),
	});
	parked.hears("a", bus);
	return { parked, stop, asking, bus, said };
}

/** The record of the calls `a`'s park carried, where the test's parking keeps it. */
const callsFile = () => join(dir, "a", "carried-calls.json");

// 22 November, 05:52: 26 of 78 background conversations on optimus, 8.8 GB,
// stayed awake only because a bash call was out, most of them a loop
// waiting on another run's rc. A host restart already carries such calls
// to the next host; a park now carries them the same way and wakes the
// conversation once the last one ends.
describe("a park that carries bash calls", () => {
	it("stops the conversation carrying its calls where the host keeps them, and not where it can't", async () => {
		const kept = carrying([], new Set());
		await kept.parked.park("a");
		expect(kept.stop, "kept: carried").toHaveBeenCalledWith("a", PARKED, true);
		kept.parked.unwatch("a");

		const unkept = carrying([call("cut")], new Set(), false);
		await unkept.parked.park("a");
		expect(unkept.stop, "unkept: cut off as before").toHaveBeenCalledWith(
			"a",
			PARKED,
			false,
		);
		expect(existsSync(callsFile()), "nothing carried to record").toBe(false);
		await quietFor(CALLS_LOOKED_AT_MS, 5);
		expect(unkept.asking, "nothing to wake for").not.toHaveBeenCalled();
		unkept.parked.unwatch("a");
	});

	it("wakes it once the last call it carried ends, and not before", async () => {
		const first = call("first");
		const second = call("second");
		const runs = new Set([first.keep, second.keep]);
		const { parked, asking } = carrying([first, second], runs);
		await parked.park("a");

		await quietFor(CALLS_LOOKED_AT_MS, 5);
		expect(existsSync(parked.wakeFile("a")), "both still run").toBe(false);
		expect(asking, "both still run").not.toHaveBeenCalled();
		runs.delete(first.keep);
		await quietFor(CALLS_LOOKED_AT_MS, 5);
		expect(existsSync(parked.wakeFile("a")), "one still runs").toBe(false);
		expect(asking, "one still runs").not.toHaveBeenCalled();
		runs.delete(second.keep);

		await until("the last call's end to wake it", () =>
			asking.mock.calls.some(([id]) => id === "a"),
		);
		expect(asking, "woken once").toHaveBeenCalledOnce();
		parked.unwatch("a");
	});

	it("says in the journal what a park carried, and when it ended", async () => {
		const runs = new Set([join(dir, "loop")]);
		const { parked, asking, said } = carrying([call("loop")], runs);
		await parked.park("a");
		expect(said).toEqual(["a: its park carries 1 bash call(s)"]);
		runs.clear();
		await until("its end to wake it", () => asking.mock.calls.length > 0);
		expect(said).toContain(
			"a: the 1 bash call(s) its park carried ended; waking it",
		);
		parked.unwatch("a");
	});

	// A refused wake, unlike a message's, has no sender to ask again (#1981).
	it("asks again for a wake refused after its calls ended, until it runs", async () => {
		let refusals = 1;
		const { parked, asking } = carrying([call("done")], new Set(), true, {
			asking: () =>
				refusals-- > 0
					? Promise.reject(new Error("the host is stopping"))
					: Promise.resolve(),
			wakeAgainMs: CALLS_LOOKED_AT_MS * 3,
		});
		await parked.park("a");
		await until("a second wake", () => asking.mock.calls.length >= 2);
		parked.unwatch("a");
		parked.ran("a");
		const asked = asking.mock.calls.length;
		await quietFor(CALLS_LOOKED_AT_MS * 3, 3);
		expect(asking.mock.calls.length, "none once it runs").toBe(asked);
	});

	it("wakes it as soon as it parks when the calls it carried can't be recorded, then carries none for an hour", async () => {
		const runs = new Set([join(dir, "loop")]);
		let clock = 0;
		const { parked, asking, stop } = carrying([call("loop")], runs, true, {
			// The record can't be renamed over a folder.
			beforeCarry: () => mkdirSync(callsFile(), { recursive: true }),
			now: () => clock,
		});
		await parked.park("a");
		await until("a wake at once", () => asking.mock.calls.length > 0);
		parked.unwatch("a");
		// Each park it can't record would end in a wake: it holds its calls
		// awake instead, rather than park and wake in a loop (#1981 F73).
		expect(parked.mayCarry("a"), "carries none").toBe(false);
		// The folder in its record's place goes, so the next park gets as far
		// as its stop; a write that would fail again is never tried.
		rmSync(callsFile(), { recursive: true });
		await parked.park("a");
		expect(stop, "its next park cuts nothing off").toHaveBeenLastCalledWith(
			"a",
			PARKED,
			false,
		);
		parked.unwatch("a");
		clock = UNRECORDED_HOLDS_MS - 1;
		expect(parked.mayCarry("a"), "within the hour").toBe(false);
		clock = UNRECORDED_HOLDS_MS;
		expect(parked.mayCarry("a"), "an hour on, it tries again").toBe(true);
	});

	it("holds the wake for calls it couldn't record while the host drains, as any wake", async () => {
		let draining = true;
		const { parked, asking } = carrying([call("loop")], new Set(), true, {
			beforeCarry: () => mkdirSync(callsFile(), { recursive: true }),
			holding: () => draining,
		});
		await parked.park("a");
		await quietFor(CALLS_LOOKED_AT_MS, 5);
		expect(asking, "held through the drain").not.toHaveBeenCalled();
		draining = false;
		parked.release();
		await until(
			"its wake once the drain lifts",
			() => asking.mock.calls.length > 0,
		);
		parked.unwatch("a");
	});

	it("wakes it when its stop fails after its calls were carried, with nobody watching them", async () => {
		const { parked, asking } = carrying(
			[call("loop")],
			new Set([join(dir, "loop")]),
			true,
			{
				afterCarry: () => {
					throw new Error("the stop failed late");
				},
			},
		);
		await parked.park("a");
		await until(
			"a wake for calls nobody watches",
			() => asking.mock.calls.length > 0,
		);
		parked.unwatch("a");
	});

	it("wakes it at once when each call it carried ended as it parked", async () => {
		const { parked, asking } = carrying([call("quick")], new Set());
		await parked.park("a");

		await until(
			"the ended call to wake it",
			() => asking.mock.calls.length > 0,
		);
		parked.unwatch("a");
	});

	it("keeps no watch on calls carried outside its park, as a move's are", async () => {
		const { parked, asking, bus, said } = carrying([], new Set());
		const moved: JobsCarried = {
			session: "a",
			jobs: [{ id: "j9", kind: "shell", label: "moved", work: call("moved") }],
		};
		await parked.park("a");
		// Heard once it parked, with no park to clear a record after it.
		bus.emit(JOBS_CARRIED, moved);
		expect(said, "no carry said").toEqual([]);

		await quietFor(CALLS_LOOKED_AT_MS, 5);
		expect(existsSync(callsFile()), "nothing recorded").toBe(false);
		expect(
			asking,
			"a carry outside its park wakes nothing",
		).not.toHaveBeenCalled();
		parked.unwatch("a");
	});

	it("watches on in the host that takes its rest over, waking it once its calls end", async () => {
		const looping = call("looping");
		const runs = new Set([looping.keep]);
		const before = carrying([looping], runs);
		await before.parked.park("a");
		// The child ends parked, or the host restarts: its watch goes with it.
		before.parked.unwatch("a");

		const after = carrying([], runs);
		after.parked.rests("a");
		await quietFor(CALLS_LOOKED_AT_MS, 5);
		expect(after.asking, "still running").not.toHaveBeenCalled();
		runs.delete(looping.keep);

		await until(
			"its end to wake it in the next host",
			() => after.asking.mock.calls.length > 0,
		);
		expect(
			before.asking,
			"the host it left wakes nothing",
		).not.toHaveBeenCalled();
		after.parked.unwatch("a");
	});

	it("forgets what it carried once it runs, so a later rest wakes nothing for it", async () => {
		const taken = call("taken");
		const before = carrying([taken], new Set([taken.keep]));
		await before.parked.park("a");
		before.parked.running("a");
		expect(
			existsSync(callsFile()),
			"a start that may yet fail keeps the record",
		).toBe(true);
		before.parked.unwatch("a");
		before.parked.ran("a");
		expect(existsSync(callsFile()), "it runs: forgotten").toBe(false);

		const after = carrying([], new Set());
		after.parked.rests("a");
		await quietFor(CALLS_LOOKED_AT_MS, 5);
		expect(
			after.asking,
			"taken up as it ran: nothing to wake for",
		).not.toHaveBeenCalled();
		after.parked.unwatch("a");
	});

	it("watches on through a start that fails, waking it once its calls end", async () => {
		const looping = call("looping");
		const runs = new Set([looping.keep]);
		const { parked, asking } = carrying([looping], runs);
		await parked.park("a");
		// Woken by a message, its build fails after it registered: still parked.
		parked.running("a");
		expect(
			existsSync(callsFile()),
			"the record stays for the next holder",
		).toBe(true);
		runs.delete(looping.keep);
		await until(
			"its calls' end to wake it",
			() => asking.mock.calls.length > 0,
		);
		parked.unwatch("a");
	});

	// The calls' marks are read from /proc, so only where there is one.
	it.runIf(process.platform === "linux")(
		"stops the calls a park carried as it closes for good, and only forgets them as it is released",
		async () => {
			const running = (name: string, carries = true) => {
				const mark = `mark-${name}-${process.pid}`;
				const child = spawn("sleep", ["60"], {
					detached: true,
					stdio: "ignore",
					env: carries
						? { ...process.env, [CALL_VARIABLE]: mark }
						: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
				});
				const ended = new Promise<void>((done) =>
					child.once("exit", () => done()),
				);
				if (child.pid === undefined) throw new Error("sleep did not start");
				const pid = child.pid;
				const work: CarriedShell = { ...call(name), pid, mark };
				const lives = () => {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						// Gone: nothing to signal.
						return false;
					}
				};
				return { child, ended, work, lives };
			};
			const closed = running("closed");
			const released = running("released");
			// Its pid taken by a process that isn't the call (#1981 F71).
			const reused = running("reused", false);
			try {
				const forGood = carrying([closed.work], new Set([closed.work.keep]));
				await forGood.parked.park("a");
				forGood.parked.closed("a", true);
				await closed.ended;
				expect(existsSync(callsFile()), "closed: forgotten").toBe(false);

				const handed = carrying([released.work], new Set([released.work.keep]));
				await handed.parked.park("a");
				handed.parked.closed("a", false);
				expect(existsSync(callsFile()), "released: forgotten").toBe(false);

				const other = carrying([reused.work], new Set([reused.work.keep]));
				await other.parked.park("a");
				other.parked.closed("a", true);
				// A kill lands in moments; give it time to before looking.
				await quietFor(50, 3);
				expect(released.lives(), "its new holder takes it up").toBe(true);
				expect(reused.lives(), "a pid that isn't the call lives on").toBe(true);
			} finally {
				closed.child.kill("SIGKILL");
				released.child.kill("SIGKILL");
				reused.child.kill("SIGKILL");
			}
		},
	);

	it("closes on when what it carried can't be read or removed", async () => {
		const { parked } = carrying([], new Set());
		await parked.park("a");
		mkdirSync(join(callsFile(), "inside"), { recursive: true });
		expect(() => parked.closed("a", true), "for good").not.toThrow();
		expect(() => parked.closed("a", false), "released").not.toThrow();
		expect(() => parked.ran("a"), "as it runs").not.toThrow();
	});

	// Stopping before the stop would leave it awake while its watch
	// believes it parked, never parking again until it reloads (#1981 F28).
	it("parks all the same when an earlier park's record can't be removed", async () => {
		const { parked, stop } = carrying([], new Set());
		mkdirSync(join(callsFile(), "inside"), { recursive: true });

		await parked.park("a");

		expect(stop).toHaveBeenCalledTimes(1);
		parked.unwatch("a");
	});
});
