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
import { steerWaiting } from "../../../lib/jobs/steer.ts";
import { giveSteer } from "../../../lib/mesh/steer.ts";

const ADDRESS = "A1B2C3";

/** What the bus hears when a talk is said as a typed line is. */
const JOBS_STEERED = "jobs:steered:v1";

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
	/** What one steer becomes, given to a session busy or idle. */
	const handed = async (
		steer: Parameters<typeof giveSteer>[2],
		idle: boolean,
	): Promise<{ sent: Sent[]; emitted: Emitted[] }> => {
		const root = mkdtempSync(join(tmpdir(), "steerer-"));
		roots.push(root);
		const sent: Sent[] = [];
		const emitted: Emitted[] = [];
		const m = sessionAt(idle, sent, emitted);
		giveSteer(root, ADDRESS, steer);
		createSteerer(m).steer(root);
		await m.steering?.look();
		m.steering?.stop();
		return { sent, emitted };
	};

	/** The names of the events a hand-over said, in order. */
	const names = (emitted: Emitted[]) => emitted.map(([name]) => name);

	it("steers Joel's launcher talk into a busy run, said as a typed line is", async () => {
		const { sent, emitted } = await handed(
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
		expect(names(emitted)).toContain(JOBS_STEERED);
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
		expect(names(waits.emitted)).not.toContain(JOBS_STEERED);
		expect(now.sent.map(([, options]) => options)).toEqual([
			{ deliverAs: "steer" },
		]);
		expect(names(now.emitted)).toContain(JOBS_STEERED);
	});

	it("holds a peer's or the machine's words for the run's end, now or not", async () => {
		for (const from of ["ABC123", "machine"]) {
			for (const now of [undefined, true] as const) {
				const { sent, emitted } = await handed(
					{ text: "look at X", from, ...(now ? { now } : {}) },
					false,
				);
				expect(
					sent.map(([, options]) => options),
					`${from}, now ${now}`,
				).toEqual([{ deliverAs: "followUp" }]);
				expect(names(emitted), `${from}, now ${now}`).not.toContain(
					JOBS_STEERED,
				);
			}
		}
	});

	it("starts a turn with Joel's talk when the session is idle", async () => {
		const { sent, emitted } = await handed(
			{ text: "look at X", from: "joel" },
			true,
		);

		expect(sent.map(([, options]) => options)).toEqual([undefined]);
		const [said] = sent[0] ?? [];
		expect(said).not.toContain(BUSY_FRAMING);
		expect(names(emitted)).not.toContain(JOBS_STEERED);
	});

	it("holds words with no steer, as a look's answer, for a busy run's end", () => {
		const sent: Sent[] = [];
		const emitted: Emitted[] = [];
		const busy = createSteerer(sessionAt(false, sent, emitted));
		const idle = createSteerer(sessionAt(true, sent, emitted));

		busy.steered("the look's answer", false);
		idle.steered("the look's answer", true);

		expect(sent).toEqual([
			["the look's answer", { deliverAs: "followUp" }],
			["the look's answer", undefined],
		]);
		expect(names(emitted)).not.toContain(JOBS_STEERED);
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
		expect(steerWaiting(bus)).toBe(false);
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
		expect(steerWaiting(bus)).toBe(false);
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

	// F89: a session started again answers once, afresh.
	it("answers once when its session starts again", () => {
		const lives: Lives = new Map();
		const bus = createEventBus();
		const steerer = createSteerer(sessionAt(false, [], [], lives, bus));
		tell(lives, "session_start");
		steerer.steered("look at X", false, { text: "look at X", from: "joel" });
		tell(lives, "session_start");
		expect(steerWaiting(bus), "what waited before").toBe(false);
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

		expect(steerWaiting(bus)).toBe(false);
	});
});
