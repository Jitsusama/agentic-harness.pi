/**
 * The steerer hands each act and talk to pausing with the time its
 * steer says it was written, so pausing can drop a Stop or Pause that
 * came before what it would end, and hands each talk to the session in
 * the run under way or after it, as who wrote it says.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { MeshState } from "../../../extensions/mesh-workflow/peer/mesh.ts";
import { createSteerer } from "../../../extensions/mesh-workflow/peer/steerer.ts";
import { PERSON_TALKED } from "../../../lib/internal/priority/typed.ts";
import { onSteered, steerWaiting } from "../../../lib/jobs/steer.ts";
import { giveSteer } from "../../../lib/mesh/steer.ts";

const ADDRESS = "A1B2C3";

/** How many times `bus` hears a talk said as a typed line is, so far. */
function steeredOn(bus: ReturnType<typeof createEventBus>): () => number {
	let said = 0;
	onSteered(bus, () => {
		said += 1;
	});
	return () => said;
}

/**
 * A bus that counts the listeners still on it, so a test can see how
 * many answers a steerer leaves behind.
 */
function countingBus() {
	const bus = createEventBus();
	let listening = 0;
	const on: typeof bus.on = (name, handler) => {
		const off = bus.on(name, handler);
		listening += 1;
		let gone = false;
		return () => {
			if (!gone) listening -= 1;
			gone = true;
			off();
		};
	};
	return { bus: { ...bus, on }, listening: () => listening };
}

/** The framing a busy session reads the person's talk under. */
const BUSY_FRAMING = "while this session works";

/** What reached pausing, as each call's name and arguments. */
type Heard = [string, ...(string | undefined)[]];

/** A peer's state with only what the steerer reaches, pausing recorded. */
function peerHearing(heard: Heard[]) {
	const state = {
		peer: { addresses: [ADDRESS] },
		pausing: {
			act: (act: string, from?: string, at?: string) =>
				heard.push(["act", act, from, at]),
			talked: (at?: string) => heard.push(["talked", at]),
		},
		moving: { cancel: () => undefined },
		talks: { opened: () => undefined },
		pi: {
			sendUserMessage: () => undefined,
			on: () => undefined,
			events: { emit: () => undefined },
		},
		steering: undefined,
		steerRoot: undefined,
	};
	// The steerer is wired against the whole peer state; these are the
	// parts a stop and a talk reach.
	return state as unknown as MeshState;
}

/** What the steerer sent the session: its words and how they go. */
type Sent = [string, { deliverAs?: string } | undefined];

/** What the session's bus heard: each event's name and its payload. */
type Emitted = [string, unknown];

/** What pi tells the steerer of the session's life, by event name. */
type Lives = Map<string, ((event: unknown) => void)[]>;

/** Tell the steerer pi's event `name`, as pi would, with its event. */
function tell(lives: Lives, name: string, event: unknown = {}): void {
	for (const handler of lives.get(name) ?? []) handler(event);
}

/** What pi says as it starts reading `text` as a message of `role`. */
const reading = (role: string, text = "look at X") => ({
	message: { role, content: [{ type: "text", text }] },
});

/**
 * A peer's state as busy or idle, recording what reaches the session,
 * on a real bus so what the steerer answers on it can be asked, and
 * with pi's session events kept in `lives` to tell it.
 */
function sessionAt(
	idle: boolean,
	sent: Sent[],
	emitted: Emitted[],
	lives: Lives = new Map(),
	bus = createEventBus(),
) {
	const state = {
		peer: { addresses: [ADDRESS] },
		pausing: { act: () => undefined, talked: () => undefined },
		moving: { cancel: () => undefined },
		talks: { opened: () => undefined },
		ctx: { isIdle: () => idle, hasUI: false },
		pi: {
			sendUserMessage: (text: string, options?: { deliverAs?: string }) =>
				sent.push([text, options]),
			on: (name: string, handler: (event: unknown) => void) =>
				lives.set(name, [...(lives.get(name) ?? []), handler]),
			events: {
				emit: (name: string, data: unknown) => {
					emitted.push([name, data]);
					bus.emit(name, data);
				},
				on: (name: string, handler: (data: unknown) => void) =>
					bus.on(name, handler),
			},
		},
		steering: undefined,
		steerRoot: undefined,
	};
	// The steerer is wired against the whole peer state; these are the
	// parts a talk reaches.
	return state as unknown as MeshState;
}

let roots: string[] = [];
afterEach(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots = [];
});

describe("a steer the steerer takes", () => {
	it("gives pausing the time its act and its talk were written", async () => {
		const root = mkdtempSync(join(tmpdir(), "steerer-"));
		roots.push(root);
		const heard: Heard[] = [];
		const m = peerHearing(heard);
		const stopAt = "2026-11-17T05:00:00.000Z";
		const talkAt = "2026-11-17T05:00:05.000Z";
		giveSteer(root, ADDRESS, {
			text: "",
			act: "stop",
			from: "joel",
			at: stopAt,
		});
		giveSteer(root, ADDRESS, { text: "carry on", from: "joel", at: talkAt });

		createSteerer(m).steer(root);
		await m.steering?.look();
		m.steering?.stop();

		expect(heard).toEqual([
			["act", "stop", "joel", stopAt],
			["talked", talkAt],
		]);
	});
});

describe("a talk the steerer hands a session", () => {
	/**
	 * What one steer becomes, given to a session busy or idle: what was
	 * sent, what its bus heard, how often it heard the talk said as a
	 * typed line is, and the session's bus and life to ask and tell after.
	 */
	const handed = async (
		steer: Parameters<typeof giveSteer>[2],
		idle: boolean,
	) => {
		const root = mkdtempSync(join(tmpdir(), "steerer-"));
		roots.push(root);
		const sent: Sent[] = [];
		const emitted: Emitted[] = [];
		const lives: Lives = new Map();
		const bus = createEventBus();
		const steered = steeredOn(bus);
		const m = sessionAt(idle, sent, emitted, lives, bus);
		giveSteer(root, ADDRESS, steer);
		createSteerer(m).steer(root);
		tell(lives, "session_start");
		await m.steering?.look();
		m.steering?.stop();
		return { sent, emitted, steered: steered(), bus, lives };
	};

	it("steers Joel's launcher talk into a busy run, said as a typed line is", async () => {
		const { sent, emitted, steered } = await handed(
			{ text: "look at X", from: "joel" },
			false,
		);

		expect(sent.map(([, options]) => options)).toEqual([
			{ deliverAs: "steer" },
		]);
		const [said] = sent[0] ?? [];
		expect(said).toContain(BUSY_FRAMING);
		expect(said).toContain("then do what is asked, or carry on");
		expect(emitted).toContainEqual([PERSON_TALKED, { intoRun: true }]);
		expect(steered).toBe(1);
	});

	// F97: pi reads back the words it was sent, framing and all, which
	// is what the steerer must match, not the steer's bare text.
	it("lets Joel's talk go once pi reads back the very words it was handed", async () => {
		const { sent, bus, lives } = await handed(
			{ text: "look at X", from: "joel" },
			false,
		);
		const [said = ""] = sent[0] ?? [];
		expect(said, "framed, not bare").not.toBe("look at X");

		expect(steerWaiting(bus), "once handed").toBe(true);
		tell(lives, "message_start", reading("user", "look at X"));
		expect(steerWaiting(bus), "its bare words read").toBe(true);
		tell(lives, "message_start", reading("user", said));
		expect(steerWaiting(bus), "the words it was handed read").toBe(false);
	});

	it("steers Joel's talk however his name is written", async () => {
		for (const from of ["Joel", "JOEL"]) {
			const { sent } = await handed({ text: "look at X", from }, false);
			expect(
				sent.map(([, options]) => options),
				from,
			).toEqual([{ deliverAs: "steer" }]);
		}
	});

	it("holds the node's words on his word for the run's end unless they say now", async () => {
		const waits = await handed({ text: "look at X", from: "person" }, false);
		const now = await handed(
			{ text: "look at X", from: "person", now: true },
			false,
		);

		expect(waits.sent.map(([, options]) => options)).toEqual([
			{ deliverAs: "followUp" },
		]);
		expect(waits.steered).toBe(0);
		expect(steerWaiting(waits.bus), "no steer left waiting").toBe(false);
		expect(now.sent.map(([, options]) => options)).toEqual([
			{ deliverAs: "steer" },
		]);
		expect(now.steered).toBe(1);
		expect(steerWaiting(now.bus), "a steer left waiting").toBe(true);
	});

	it("holds a peer's or the machine's words for the run's end, now or not", async () => {
		for (const from of ["ABC123", "machine"]) {
			for (const now of [undefined, true] as const) {
				const { sent, steered, bus } = await handed(
					{ text: "look at X", from, ...(now ? { now } : {}) },
					false,
				);
				expect(
					sent.map(([, options]) => options),
					`${from}, now ${now}`,
				).toEqual([{ deliverAs: "followUp" }]);
				expect(steered, `${from}, now ${now}`).toBe(0);
				expect(steerWaiting(bus), `${from}, now ${now}`).toBe(false);
			}
		}
	});

	it("starts a turn with Joel's talk when the session is idle", async () => {
		const { sent, steered, bus } = await handed(
			{ text: "look at X", from: "joel" },
			true,
		);

		expect(sent.map(([, options]) => options)).toEqual([undefined]);
		const [said] = sent[0] ?? [];
		expect(said).not.toContain(BUSY_FRAMING);
		expect(steered).toBe(0);
		expect(steerWaiting(bus), "no steer left waiting").toBe(false);
	});

	it("holds words with no steer, as a look's answer, for a busy run's end", () => {
		const sent: Sent[] = [];
		const bus = createEventBus();
		const steered = steeredOn(bus);
		const busy = createSteerer(sessionAt(false, sent, [], new Map(), bus));
		const idle = createSteerer(sessionAt(true, sent, [], new Map(), bus));

		busy.steered("the look's answer", false);
		idle.steered("the look's answer", true);

		expect(sent).toEqual([
			["the look's answer", { deliverAs: "followUp" }],
			["the look's answer", undefined],
		]);
		expect(steered()).toBe(0);
	});

	// F64: a call that starts after the talk asks whether a line waits.
	it("says Joel's steered talk waits until the run settles, as a typed line does", () => {
		const lives: Lives = new Map();
		const bus = createEventBus();
		const steerer = createSteerer(sessionAt(false, [], [], lives, bus));
		tell(lives, "session_start");
		const joel = { text: "look at X", from: "joel" };

		expect(steerWaiting(bus), "before any talk").toBe(false);
		steerer.steered("look at X", false, joel);
		expect(steerWaiting(bus), "once steered in").toBe(true);
		tell(lives, "agent_settled");
		expect(steerWaiting(bus), "once the run settles").toBe(false);
	});

	// F72: a typed line stops waiting once pi reads it, and so does talk.
	it("says Joel's talk no longer waits once pi reads it as his message", () => {
		const lives: Lives = new Map();
		const bus = createEventBus();
		const steerer = createSteerer(sessionAt(false, [], [], lives, bus));
		tell(lives, "session_start");
		steerer.steered("look at X", false, { text: "look at X", from: "joel" });

		tell(lives, "message_start", reading("assistant"));
		expect(steerWaiting(bus), "while the reply streams").toBe(true);
		tell(lives, "message_start", reading("user"));
		expect(steerWaiting(bus), "once read").toBe(false);
	});

	// F84: pi reads one steer a turn, so another's may come first.
	it("keeps Joel's talk waiting while pi reads another message first", () => {
		const lives: Lives = new Map();
		const bus = createEventBus();
		const steerer = createSteerer(sessionAt(false, [], [], lives, bus));
		tell(lives, "session_start");
		steerer.steered("look at X", false, { text: "look at X", from: "joel" });
		steerer.steered("and Y", false, { text: "and Y", from: "joel" });

		tell(lives, "message_start", reading("user", "a line typed first"));
		expect(steerWaiting(bus), "behind a typed line").toBe(true);
		tell(lives, "message_start", reading("user", "look at X"));
		expect(steerWaiting(bus), "with his second talk unread").toBe(true);
		tell(lives, "message_start", reading("user", "and Y"));
		expect(steerWaiting(bus), "once both are read").toBe(false);
	});

	// F87: pi may read it as it is sent.
	it("says nothing waits for talk pi reads as it is sent", () => {
		const lives: Lives = new Map();
		const bus = createEventBus();
		const state = sessionAt(false, [], [], lives, bus);
		state.pi.sendUserMessage = (text) =>
			tell(lives, "message_start", reading("user", String(text)));
		const steerer = createSteerer(state);
		tell(lives, "session_start");
		steerer.steered("look at X", false, { text: "look at X", from: "joel" });
		expect(steerWaiting(bus), "once pi read it as it was sent").toBe(false);
	});

	// F93: talk pi never took doesn't wait.
	it("says nothing waits for talk pi refused to take", () => {
		const lives: Lives = new Map();
		const bus = createEventBus();
		const state = sessionAt(false, [], [], lives, bus);
		state.pi.sendUserMessage = () => {
			throw new Error("no session");
		};
		const steerer = createSteerer(state);
		tell(lives, "session_start");
		expect(() =>
			steerer.steered("look at X", false, { text: "look at X", from: "joel" }),
		).toThrow("no session");
		expect(steerWaiting(bus), "once the send threw").toBe(false);
	});

	// F76, F83, F85: a reload builds a second steerer on the bus that outlives it.
	it("leaves no answer behind once its session shuts down for a reload", () => {
		const bus = createEventBus();
		const before: Lives = new Map();
		const old = createSteerer(sessionAt(false, [], [], before, bus));
		tell(before, "session_start");
		old.steered("look at X", false, { text: "look at X", from: "joel" });
		tell(before, "session_shutdown");
		expect(steerWaiting(bus), "once shut down").toBe(false);

		const after: Lives = new Map();
		createSteerer(sessionAt(false, [], [], after, bus));
		tell(after, "session_start");
		// Only an answer still on the bus could say the old steerer's words wait.
		old.steered("stale", false, { text: "stale", from: "joel" });
		expect(steerWaiting(bus), "the old steerer answers after the reload").toBe(
			false,
		);
	});

	// F89: a session started again forgets what waited before.
	it("forgets what waited when its session starts again", () => {
		const lives: Lives = new Map();
		const bus = createEventBus();
		const steerer = createSteerer(sessionAt(false, [], [], lives, bus));
		tell(lives, "session_start");
		steerer.steered("look at X", false, { text: "look at X", from: "joel" });
		tell(lives, "session_start");
		expect(steerWaiting(bus), "what waited before").toBe(false);
	});

	// F95, F99: each start puts the last answer down before it answers.
	it("answers once however often its session starts, and not after it shuts down", () => {
		const lives: Lives = new Map();
		const { bus, listening } = countingBus();
		createSteerer(sessionAt(false, [], [], lives, bus));
		const before = listening();

		tell(lives, "session_start");
		tell(lives, "session_start");
		tell(lives, "session_start");
		expect(listening() - before, "after three starts").toBe(1);
		tell(lives, "session_shutdown");
		expect(listening() - before, "once shut down").toBe(0);
	});

	// F98: the same words twice wait until pi has read both.
	it("keeps the second of two identical talks waiting until pi reads it too", () => {
		const lives: Lives = new Map();
		const bus = createEventBus();
		const steerer = createSteerer(sessionAt(false, [], [], lives, bus));
		tell(lives, "session_start");
		const joel = { text: "look at X", from: "joel" };
		steerer.steered("look at X", false, joel);
		steerer.steered("look at X", false, joel);

		tell(lives, "message_start", reading("user", "look at X"));
		expect(steerWaiting(bus), "one read of two").toBe(true);
		tell(lives, "message_start", reading("user", "look at X"));
		expect(steerWaiting(bus), "both read").toBe(false);
	});

	it("says nothing waits for words held for the run's end", () => {
		const lives: Lives = new Map();
		const bus = createEventBus();
		const steerer = createSteerer(sessionAt(false, [], [], lives, bus));
		tell(lives, "session_start");

		steerer.steered("look at X", false, { text: "look at X", from: "person" });
		steerer.steered("look at X", false, { text: "look at X", from: "ABC123" });
		steerer.steered("the look's answer", false);
		steerer.steered("look at X", true, { text: "look at X", from: "joel" });

		expect(steerWaiting(bus), "with every word held for the run's end").toBe(
			false,
		);
	});
});
