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
