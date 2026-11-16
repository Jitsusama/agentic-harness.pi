/** The service wakes a parked conversation as it resumes one: in turn with a close of it, through the rollout gate, and side by side with a few others, a window's first. */
import { describe, expect, it, vi } from "vitest";
import { parseOpenResult } from "../../../host/service/protocol.ts";
import { WAKE_PLACES } from "../../../host/service/wake-places.ts";
import { until } from "../../support/until.ts";
import {
	attach,
	heldGate,
	LONGEST_MS,
	NEVER_MS,
	open,
	settle,
	TIMER_EARLY_MS,
	wakeHost,
} from "./support/wakes.ts";

const wakes = wakeHost();
const { register, engine, backendWith, heldResumes, parked } = wakes;

describe("waking a parked conversation", () => {
	it("resumes it once, leaving one already awake alone", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const sessionId = await parked(backend);

		await Promise.all([backend.wake(sessionId), backend.wake(sessionId)]);

		expect(
			fake.resume,
			"two wakes at once resume it once, as a wake",
		).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ sessionId }),
			true,
		);
		expect(wakes.host.holds(sessionId), "it runs again").toBe("idle");
	});

	it("leaves one released while it slept gone, telling its screen why, even with the wake asked first", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const sessionId = await parked(backend);

		const closing = backend.execute({
			v: 1,
			id: "c",
			op: "release",
			sessionId,
			by: "the cutover",
		});
		const waking = backend.wake(sessionId);
		await Promise.all([closing, waking]);

		expect(
			fake.resume,
			"the wake asked in the close's turn finds it gone",
		).not.toHaveBeenCalled();
		expect(
			fake.dropped,
			"its kept screen was let go, told it was released",
		).toHaveBeenCalledWith(
			sessionId,
			"released, asked by the cutover over the control socket",
		);
		expect(
			fake.handsOn,
			"a release hands it on, so what its calls left is kept",
		).toHaveBeenCalledExactlyOnceWith(sessionId);
		expect(wakes.host.holds(sessionId), "it stays closed").toBeUndefined();
	});

	it("hands nothing on when one is closed for good, parked or running", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const sleeping = await parked(backend);
		const { sessionId: running } = parseOpenResult(await backend.execute(open));

		for (const [id, sessionId] of [
			["c1", sleeping],
			["c2", running],
		] as const)
			await backend.execute({ v: 1, id, op: "close", sessionId, by: "Joel" });

		expect(
			fake.handsOn,
			"a close ends what its calls left",
		).not.toHaveBeenCalled();
		expect(wakes.host.holds(running), "it closed").toBeUndefined();
	});

	it("closes one released while it parks as a parked one, saying the end before telling its screen", async () => {
		const said: string[] = [];
		let parking: Promise<void> | undefined;
		const fake = engine({
			parkSettled: () => parking ?? Promise.resolve(),
			dropped: vi.fn(async () => {
				said.push("dropped");
			}),
		});
		const backend = backendWith(fake, undefined, (line) => said.push(line));
		const { sessionId } = parseOpenResult(await backend.execute(open));

		parking = wakes.host.stop(sessionId, "parked while idle");
		await backend.execute({
			v: 1,
			id: "r",
			op: "release",
			sessionId,
			by: "the cutover",
		});

		expect(
			fake.dropped,
			"its kept screen was let go, told it was released",
		).toHaveBeenCalledWith(
			sessionId,
			"released, asked by the cutover over the control socket",
		);
		expect(said, "the end was said, then its screen told").toEqual([
			expect.stringContaining(
				"ended: released, asked by the cutover over the control socket, held but not running",
			),
			"dropped",
		]);
		expect(
			wakes.roster.entries().map((held) => held.sessionId),
			"the roster let it go",
		).not.toContain(sessionId);
	});

	it("says a wake of one held but not running can't, since its start or its park failed, and that a close lets it go", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const { sessionId } = parseOpenResult(await backend.execute(open));
		wakes.host.state(sessionId, "parked");

		await expect(
			backend.wake(sessionId),
			"the wake says why it can't",
		).rejects.toThrow(
			/is held but not running, since its last start or park failed; close it and open it again/,
		);
		expect(fake.resume, "nothing resumed").not.toHaveBeenCalled();
	});

	it("waits out every wake under way before saying it settled", async () => {
		let resumed: (() => void) | undefined;
		const waking = new Promise<void>((resolve) => {
			resumed = resolve;
		});
		const fake = engine({
			resume: vi.fn(async (entry) => {
				await waking;
				register(entry);
			}),
		});
		const backend = backendWith(fake);
		const sessionId = await parked(backend);
		let settled = false;

		const woke = backend.wake(sessionId);
		const settling = backend.settled().then(() => {
			settled = true;
		});
		await until(
			"the wake to resume it",
			() => vi.mocked(fake.resume).mock.calls.length > 0,
		);
		expect(settled, "unsettled while the wake resumes").toBe(false);
		resumed?.();
		await woke;
		await settling;

		expect(wakes.host.holds(sessionId), "settled once it runs").toBe("idle");
	});

	it("goes through the rollout gate beside another conversation, and stays parked when refused", async () => {
		const fake = engine();
		const refused = new Error("pid 41 runs a harness before the census change");
		const gate = vi.fn(() => Promise.reject(refused));
		const backend = backendWith(fake, gate);
		const sessionId = await parked(backend);
		// The first open passes without asking; a second would ask.
		gate.mockClear();
		await backendWith(engine()).execute(open);

		await expect(backend.wake(sessionId)).rejects.toBe(refused);

		expect(
			gate,
			"the wake asked the gate, as a wake",
		).toHaveBeenCalledExactlyOnceWith("wake");
		expect(
			fake.resume,
			"a refused wake resumes nothing",
		).not.toHaveBeenCalled();
		expect(
			wakes.roster.entries().map((held) => held.sessionId),
			"it stays held, parked",
		).toContain(sessionId);
	});

	it("wakes it as a window attaches, then answers its identity", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const sessionId = await parked(backend);

		await expect(
			backend.execute({
				v: 1,
				id: "t",
				op: "attach",
				sessionId,
				rows: 40,
				columns: 120,
			}),
		).resolves.toEqual({ sessionId });

		expect(fake.resume, "the attach woke it").toHaveBeenCalledOnce();
		expect(wakes.host.holds(sessionId), "it runs for the window").toBe("idle");
	});
});

describe("waking conversations side by side, a window's first", () => {
	it("resumes wakes side by side up to its places, the next once one ends", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, { wakePlaces: 2 });
		const [first, second, third] = [
			await parked(backend),
			await parked(backend),
			await parked(backend),
		];

		const woken = [first, second, third].map((id) => backend.wake(id));
		await until("two wakes to resume", () => begun.length === 2);
		await settle();

		expect(begun, "two resume at once, the third waits").toEqual([
			first,
			second,
		]);
		finish(second);
		await until("the third wake to resume", () => begun.length === 3);
		finish(first);
		finish(third);
		await Promise.all(woken);

		expect(wakes.host.holds(third), "the third runs too").toBe("idle");
	});

	it("resumes a window's attach at once, every place taken", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, { wakePlaces: 1 });
		const waking = await parked(backend);
		const messaged = await parked(backend);
		const watched = await parked(backend);

		const woken = backend.wake(waking);
		await until("the first wake to resume", () => begun.length === 1);
		const queued = backend.wake(messaged);
		const attached = backend.execute(attach(watched));
		await until("the window's wake to resume", () => begun.length === 2);

		expect(begun, "the window's went past the one waiting").toEqual([
			waking,
			watched,
		]);
		finish(watched);
		await attached;
		finish(waking);
		await until("the message's wake to resume", () => begun.length === 3);
		finish(messaged);
		await Promise.all([woken, queued]);

		expect(wakes.host.holds(messaged), "the message's wake still ran").toBe(
			"idle",
		);
	});

	it("begins no other wake while a window's resumes", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, { wakePlaces: 4 });
		const watched = await parked(backend);
		const messaged = await parked(backend);

		const attached = backend.execute(attach(watched));
		await until("the window's wake to resume", () => begun.length === 1);
		const queued = backend.wake(messaged);
		await settle();

		expect(begun, "the message's wake waits for the window's").toEqual([
			watched,
		]);
		finish(watched);
		await until("the message's wake to resume", () => begun.length === 2);
		finish(messaged);
		await Promise.all([attached, queued]);

		expect(wakes.host.holds(messaged), "it runs once the window's has").toBe(
			"idle",
		);
	});

	it("resumes at once a window opened on one whose own wake waits for a place", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, {
			wakePlaces: 1,
			wakeLongestMs: NEVER_MS,
		});
		const waking = await parked(backend);
		const messaged = await parked(backend);

		const woken = backend.wake(waking);
		await until("the first wake to resume", () => begun.length === 1);
		const queued = backend.wake(messaged);
		await settle();
		const attached = backend.execute(attach(messaged));
		await until("the window's wake to resume", () => begun.length === 2);

		expect(begun, "its waiting wake went in as the window's").toEqual([
			waking,
			messaged,
		]);
		finish(messaged);
		await Promise.all([attached, queued]);
		finish(waking);
		await woken;

		expect(fake.resume, "each resumed once").toHaveBeenCalledTimes(2);
	});

	it("lets no other wake on beside a window opened on one whose own wake already resumes", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, {
			wakePlaces: 2,
			wakeLongestMs: NEVER_MS,
		});
		const waking = await parked(backend);
		const messaged = await parked(backend);
		const third = await parked(backend);

		const woken = backend.wake(waking);
		const wokenToo = backend.wake(messaged);
		await until("two wakes to resume", () => begun.length === 2);
		const queued = backend.wake(third);
		const attached = backend.execute(attach(messaged));
		await settle();
		finish(waking);
		await woken;
		await settle();

		expect(begun, "the freed place waits for the window's resume").toEqual([
			waking,
			messaged,
		]);
		finish(messaged);
		await Promise.all([wokenToo, attached]);
		await until("the third wake to resume", () => begun.length === 3);
		finish(third);
		await queued;
	});

	it("resumes at once a window opened on one whose own wake waits at the rollout gate", async () => {
		const { fake, begun, finish } = heldResumes();
		const { gate, hold, waits, open } = heldGate();
		const backend = backendWith(fake, gate, undefined, {
			wakePlaces: 1,
			wakeLongestMs: NEVER_MS,
		});
		const waking = await parked(backend);
		const messaged = await parked(backend);

		const woken = backend.wake(waking);
		await until("the first wake to resume", () => begun.length === 1);
		hold();
		const queued = backend.wake(messaged);
		await until("the message's wake to wait at the gate", waits);
		const attached = backend.execute(attach(messaged));
		await settle();
		open();
		await until("the window's wake to resume", () => begun.length === 2);

		expect(begun, "its wake went in as the window's").toEqual([
			waking,
			messaged,
		]);
		finish(messaged);
		await Promise.all([attached, queued]);
		finish(waking);
		await woken;
	});

	it("lets every wake still waiting on at once when told the host stops, and any asked after", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, {
			wakePlaces: 1,
			wakeLongestMs: NEVER_MS,
		});
		const waking = await parked(backend);
		const messaged = await parked(backend);
		const written = await parked(backend);
		const late = await parked(backend);

		const woken = [backend.wake(waking)];
		await until("the first wake to resume", () => begun.length === 1);
		woken.push(backend.wake(messaged), backend.wake(written));
		await settle();
		backend.freeWakes();
		await until("the waiting wakes to resume", () => begun.length === 3);
		woken.push(backend.wake(late));
		await until("a wake asked after to resume", () => begun.length === 4);

		expect(begun, "none lost, none held back").toEqual([
			waking,
			messaged,
			written,
			late,
		]);
		for (const id of begun) finish(id);
		await Promise.all(woken);
		await backend.settled();
	});

	it("lets the others on once a resume a window took in has run the longest it began with", async () => {
		const { fake, begun, begunAt, finish } = heldResumes();
		const longest = 3 * LONGEST_MS;
		const backend = backendWith(fake, undefined, undefined, {
			wakePlaces: 2,
			wakeLongestMs: longest,
		});
		const messaged = await parked(backend);
		const other = await parked(backend);

		const woken = backend.wake(messaged);
		await until("the message's wake to resume", () => begun.length === 1);
		// A real pause is the point: the attach comes a third of the way into
		// the first resume's longest, late enough that a clock begun afresh at
		// it would show, with two thirds left before a slow runner lapses it.
		await new Promise((resolve) => setTimeout(resolve, LONGEST_MS));
		const attachedAt = Date.now();
		await backend.execute(attach(messaged));
		const queued = backend.wake(other);
		await settle();
		expect(begun, "a place is free, yet the window's resume holds it").toEqual([
			messaged,
		]);
		await until("the other wake to resume", () => begun.length === 2);

		expect(
			Number(begunAt[1]) - Number(begunAt[0]),
			"it waited out the first resume's longest",
		).toBeGreaterThanOrEqual(longest - TIMER_EARLY_MS);
		expect(
			Number(begunAt[1]) - attachedAt,
			"from its begin, not a fresh one from the attach",
		).toBeLessThan(longest - TIMER_EARLY_MS);
		finish(messaged);
		finish(other);
		await Promise.all([woken, queued]);
	});

	it("wakes one a window had again in its turn, a window's hurry over", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, {
			wakePlaces: 1,
			wakeLongestMs: NEVER_MS,
		});
		const windowed = await parked(backend);
		const other = await parked(backend);

		const attached = backend.execute(attach(windowed));
		await until("the window's resume", () => begun.length === 1);
		finish(windowed);
		await attached;
		await wakes.host.stop(windowed, "parked while idle");
		const first = backend.wake(other);
		await until("the other wake to resume", () => begun.length === 2);
		const again = backend.wake(windowed);
		await settle();

		expect(begun, "its wake waits for the place like any").toEqual([
			windowed,
			other,
		]);
		finish(other);
		await until("its wake to resume", () => begun.length === 3);
		finish(windowed);
		await Promise.all([first, again]);
	});

	it("says a resume that ran its longest then failed failed, not resumed", async () => {
		const said: string[] = [];
		const failed = new Error("its build failed");
		let fail: (() => void) | undefined;
		const failing = engine({
			resume: vi.fn(async (entry) => {
				register(entry);
				await new Promise<void>((resolve) => {
					fail = resolve;
				});
				throw failed;
			}),
		});
		const backend = backendWith(failing, undefined, (line) => said.push(line), {
			wakeLongestMs: LONGEST_MS,
		});
		const sessionId = await parked(backend);

		const woke = backend.wake(sessionId);
		await until("the resume to run its longest", () =>
			said.some((line) => line.includes(sessionId)),
		);
		fail?.();
		await expect(woke, "the wake fails").rejects.toBe(failed);

		expect(
			said.filter((line) => line.includes(sessionId)).at(-1),
			"the journal says it failed",
		).toMatch(/failed after/);
	});

	it("resumes at once a wake a person asked for by typing to its window", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, {
			wakePlaces: 1,
			wakeLongestMs: NEVER_MS,
		});
		const waking = await parked(backend);
		const typedTo = await parked(backend);

		const woken = backend.wake(waking);
		await until("the first wake to resume", () => begun.length === 1);
		const typed = backend.wake(typedTo, "window");
		await until("the typed-to wake to resume", () => begun.length === 2);

		expect(begun, "a key's wake went past the place taken").toEqual([
			waking,
			typedTo,
		]);
		finish(typedTo);
		finish(waking);
		await Promise.all([woken, typed]);
	});

	it("lets the other wakes on once a window's resume has run its longest", async () => {
		const said: string[] = [];
		const { fake, begun, begunAt, finish } = heldResumes();
		const backend = backendWith(fake, undefined, (line) => said.push(line), {
			wakePlaces: 4,
			wakeLongestMs: LONGEST_MS,
		});
		const watched = await parked(backend);
		const messaged = await parked(backend);

		const attached = backend.execute(attach(watched));
		await until("the window's wake to resume", () => begun.length === 1);
		const queued = backend.wake(messaged);
		await until("the message's wake to resume", () => begun.length === 2);

		expect(
			Number(begunAt[1]) - Number(begunAt[0]),
			"it waited for the window's resume first",
		).toBeGreaterThanOrEqual(LONGEST_MS - TIMER_EARLY_MS);
		expect(
			said.some((line) => line.includes(watched)),
			`the journal names the resume that ran its longest: ${said.join("; ")}`,
		).toBe(true);
		finish(messaged);
		finish(watched);
		await Promise.all([attached, queued]);

		expect(
			said.some((line) => line.includes(watched) && /resumed after/.test(line)),
			`the journal says when the resume that lapsed ended: ${said.join("; ")}`,
		).toBe(true);
	});

	it("says nothing of a resume that ends within its longest", async () => {
		const said: string[] = [];
		const backend = backendWith(
			engine(),
			undefined,
			(line) => said.push(line),
			{
				wakeLongestMs: LONGEST_MS,
			},
		);
		const sessionId = await parked(backend);

		await backend.wake(sessionId);

		expect(
			said.filter((line) => line.includes(sessionId)),
			"no line for a resume in time",
		).toEqual([]);
	});

	it("lets the next wake on at a lapse, and the lapsed one end, though the journal throws", async () => {
		const { fake, begun, finish } = heldResumes();
		const gone = () => {
			throw new Error("the journal is gone");
		};
		const backend = backendWith(fake, undefined, gone, {
			wakePlaces: 1,
			wakeLongestMs: LONGEST_MS,
		});
		const lapsing = await parked(backend);
		const queued = await parked(backend);

		const lapsed = backend.wake(lapsing);
		await until("the first wake to resume", () => begun.length === 1);
		const next = backend.wake(queued);
		await until("the next to resume at the lapse", () => begun.length === 2);
		finish(lapsing);
		finish(queued);

		await expect(
			lapsed,
			"the lapsed one's wake resolves",
		).resolves.toBeUndefined();
		await next;
	});

	it("counts a resume that has run its longest no more, yet keeps to its places", async () => {
		const { fake, begun, begunAt, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, {
			wakePlaces: 1,
			wakeLongestMs: LONGEST_MS,
		});
		const stuck = await parked(backend);
		const next = await parked(backend);
		const third = await parked(backend);

		const woken = backend.wake(stuck);
		await until("the first wake to resume", () => begun.length === 1);
		const waited = backend.wake(next);
		await until("the second wake to resume", () => begun.length === 2);
		expect(
			Number(begunAt[1]) - Number(begunAt[0]),
			"it waited for a place first",
		).toBeGreaterThanOrEqual(LONGEST_MS - TIMER_EARLY_MS);
		const last = backend.wake(third);
		await settle();

		expect(begun, "the third waits for the second's place").toEqual([
			stuck,
			next,
		]);
		finish(stuck);
		await woken;
		await settle();
		expect(
			begun,
			"the first ending gives back no place it no longer held",
		).toEqual([stuck, next]);
		finish(next);
		await until("the third wake to resume", () => begun.length === 3);
		finish(third);
		await Promise.all([waited, last]);
	});

	it("gives a place back when a resume fails", async () => {
		const failed = new Error("its build failed");
		const { fake, begun, finish } = heldResumes();
		const held = fake.resume;
		const failing = engine({
			resume: vi.fn(async (entry, adopted) => {
				if (entry.sessionId === first) throw failed;
				return held(entry, adopted);
			}),
		});
		const backend = backendWith(failing, undefined, undefined, {
			wakePlaces: 1,
			wakeLongestMs: NEVER_MS,
		});
		const first = await parked(backend);
		const second = await parked(backend);

		await expect(backend.wake(first), "the first fails").rejects.toBe(failed);
		const woken = backend.wake(second);
		await until("the second wake to resume", () => begun.length === 1);
		finish(second);
		await woken;

		expect(wakes.host.holds(second), "the second runs").toBe("idle");
	});

	it("lets the others on when a window's resume fails", async () => {
		const failed = new Error("its build failed");
		const { fake, begun, finish } = heldResumes();
		const held = fake.resume;
		const failing = engine({
			resume: vi.fn(async (entry, adopted) => {
				if (entry.sessionId === watched) throw failed;
				return held(entry, adopted);
			}),
		});
		const backend = backendWith(failing, undefined, undefined, {
			wakePlaces: 1,
			wakeLongestMs: NEVER_MS,
		});
		const watched = await parked(backend);
		const messaged = await parked(backend);

		await expect(
			backend.wake(watched, "window"),
			"the window's fails",
		).rejects.toBe(failed);
		const woken = backend.wake(messaged);
		await until("the message's wake to resume", () => begun.length === 1);
		finish(messaged);
		await woken;

		expect(wakes.host.holds(messaged), "the message's wake ran").toBe("idle");
	});

	it("lets no waiting wake on as a place frees beside a window's resume", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, {
			wakePlaces: 1,
			wakeLongestMs: NEVER_MS,
		});
		const waking = await parked(backend);
		const messaged = await parked(backend);
		const watched = await parked(backend);

		const woken = backend.wake(waking);
		await until("the first wake to resume", () => begun.length === 1);
		const queued = backend.wake(messaged);
		const attached = backend.execute(attach(watched));
		await until("the window's wake to resume", () => begun.length === 2);
		finish(waking);
		await woken;
		await settle();

		expect(begun, "the freed place waits for the window's resume").toEqual([
			waking,
			watched,
		]);
		finish(watched);
		await until("the message's wake to resume", () => begun.length === 3);
		finish(messaged);
		await Promise.all([attached, queued]);
	});

	it("wakes a burst of twenty four at a time, each next as one ends", async () => {
		const burst = 20;
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake);
		const ids: string[] = [];
		for (let made = 0; made < burst; made += 1) ids.push(await parked(backend));

		const woken = ids.map((id) => backend.wake(id));
		for (let ended = 0; ended < burst; ended += 1) {
			const resuming = Math.min(burst, ended + WAKE_PLACES);
			await until(
				`${resuming} wakes to have begun`,
				() => begun.length === resuming,
			);
			await settle();
			expect(
				begun.length,
				`${ended} ended, so ${WAKE_PLACES} at most resume`,
			).toBe(resuming);
			const oldest = begun[ended];
			if (oldest === undefined) throw new Error(`no wake began ${ended}th`);
			finish(oldest);
		}
		await Promise.all(woken);

		// Pinned so that retuning it is a choice made here, with the soak.
		expect(WAKE_PLACES, "a few side by side, not one or all").toBe(4);
		for (const id of ids)
			expect(wakes.host.holds(id), `${id} runs again`).toBe("idle");
	});
});
