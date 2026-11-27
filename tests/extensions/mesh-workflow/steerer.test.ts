/**
 * The steerer hands each act and talk to pausing with the time its
 * steer says it was written, so pausing can drop a Stop or Pause that
 * came before what it would end.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MeshState } from "../../../extensions/mesh-workflow/peer/mesh.ts";
import { createSteerer } from "../../../extensions/mesh-workflow/peer/steerer.ts";
import { giveSteer } from "../../../lib/mesh/steer.ts";

const ADDRESS = "A1B2C3";

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
		pi: { sendUserMessage: () => undefined, events: { emit: () => undefined } },
		steering: undefined,
		steerRoot: undefined,
	};
	// The steerer is wired against the whole peer state; these are the
	// parts a stop and a talk reach.
	return state as unknown as MeshState;
}

/** What the steerer sent the session: its words and how they go. */
type Sent = [string, { deliverAs?: string } | undefined];

/** A peer's state as busy or idle, recording what reaches the session. */
function sessionAt(idle: boolean, sent: Sent[]) {
	const state = {
		peer: { addresses: [ADDRESS] },
		pausing: { act: () => undefined, talked: () => undefined },
		moving: { cancel: () => undefined },
		talks: { opened: () => undefined },
		ctx: { isIdle: () => idle, hasUI: false },
		pi: {
			sendUserMessage: (text: string, options?: { deliverAs?: string }) =>
				sent.push([text, options]),
			events: { emit: () => undefined },
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
	): Promise<Sent[]> => {
		const root = mkdtempSync(join(tmpdir(), "steerer-"));
		roots.push(root);
		const sent: Sent[] = [];
		const m = sessionAt(idle, sent);
		giveSteer(root, ADDRESS, steer);
		createSteerer(m).steer(root);
		await m.steering?.look();
		m.steering?.stop();
		return sent;
	};

	it("steers the person's talk into a busy run, framed as said while it works", async () => {
		const sent = await handed({ text: "look at X", from: "joel" }, false);

		expect(sent.map(([, options]) => options)).toEqual([
			{ deliverAs: "steer" },
		]);
		expect(sent[0]?.[0]).toContain("while this session works");
		expect(sent[0]?.[0]).toContain("then do what is asked, or carry on");
	});

	it("holds a peer's or the machine's words for the run's end, now or not", async () => {
		for (const from of ["ABC123", "machine"]) {
			for (const now of [undefined, true] as const) {
				const sent = await handed(
					{ text: "look at X", from, ...(now ? { now } : {}) },
					false,
				);
				expect(
					sent.map(([, options]) => options),
					`${from}, now ${now}`,
				).toEqual([{ deliverAs: "followUp" }]);
				expect(sent[0]?.[0], `${from}, now ${now}`).not.toContain(
					"while this session works",
				);
			}
		}
	});

	it("starts a turn with the person's talk when the session is idle", async () => {
		const sent = await handed({ text: "look at X", from: "joel" }, true);

		expect(sent.map(([, options]) => options)).toEqual([undefined]);
		expect(sent[0]?.[0]).not.toContain("while this session works");
	});
});
