/**
 * Damping: a peer's limits on the attention messages deserve.
 */
import { describe, expect, it } from "vitest";
import type { Heed } from "../../../lib/mesh/attention.ts";
import {
	createDamper,
	HOUR_MS,
	MOST_REPLY_DEPTH,
	MOST_TURNS_AN_HOUR,
	MOST_TURNS_FROM_ONE,
} from "../../../lib/mesh/damping.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import type { Message } from "../../../lib/mesh/message.ts";

function message(over: Partial<Message> = {}): Message {
	return {
		v: 1,
		id: "1-WCJQSG-7-aaaaaaaa",
		at: "2026-10-22T04:00:00.000Z",
		from: "WCJQSG",
		to: ["@LUQ49E"],
		intent: "question",
		text: "who has qemu?",
		pid: 7,
		...over,
	};
}

const wake: Heed = { attention: "wake", why: "sent to this peer" };
const act: Heed = { attention: "act", why: "sent to this peer" };
const at = 10 * HOUR_MS;

describe("a peer's turns", () => {
	it("stop being started by one sender past its share of the hour", () => {
		const damper = createDamper();
		for (let one = 0; one < MOST_TURNS_FROM_ONE; one += 1) {
			damper.started(["WCJQSG"], at);
		}

		expect(damper.damp(message(), wake, 0, at)).toEqual({
			attention: "note",
			why: "sent to this peer, the hour's turns for WCJQSG spent",
		});
		expect(damper.damp(message({ from: "P9R1KI" }), act, 0, at)).toEqual(act);
	});

	it("are started for an awaited answer whatever the hour has spent", () => {
		const damper = createDamper();
		for (let one = 0; one < MOST_TURNS_AN_HOUR; one += 1) {
			damper.started(["WCJQSG"], at);
		}
		const awaited: Heed = { ...wake, awaited: true };

		expect(damper.damp(message(), awaited, 1, at)).toEqual(awaited);
		expect(
			damper.damp(message(), awaited, MOST_REPLY_DEPTH + 1, at).attention,
		).toBe("note");
		damper.handed([message()], at);
		expect(damper.damp(message(), awaited, 1, at).attention).toBe("glance");
	});

	it("stop being started by anyone past the hour's", () => {
		const damper = createDamper();
		for (let one = 0; one < MOST_TURNS_AN_HOUR; one += 1) {
			damper.started([`PEER${one}`], at);
		}

		expect(damper.damp(message(), act, 0, at).attention).toBe("note");
	});

	it("come back as the hour passes", () => {
		const damper = createDamper();
		for (let one = 0; one < MOST_TURNS_AN_HOUR; one += 1) {
			damper.started(["WCJQSG"], at);
		}

		expect(damper.damp(message(), wake, 0, at + HOUR_MS).attention).toBe(
			"wake",
		);
	});

	it("are never started by an answer too deep in its thread", () => {
		const damper = createDamper();
		expect(damper.damp(message(), wake, MOST_REPLY_DEPTH, at)).toEqual(wake);
		expect(damper.damp(message(), wake, MOST_REPLY_DEPTH + 1, at)).toEqual({
			attention: "note",
			why: "sent to this peer, an answer too deep in its thread",
		});
	});

	it("are counted again from what an earlier start recorded", () => {
		const damper = createDamper();
		damper.recover(
			Array.from({ length: MOST_TURNS_FROM_ONE }, () => ({
				at,
				from: ["WCJQSG"],
			})),
			[],
		);

		expect(damper.damp(message(), wake, 0, at).attention).toBe("note");
	});
});

describe("a repeat", () => {
	it("is a glance when its sender already said it within the hour", () => {
		const damper = createDamper();
		damper.handed([message()], at);

		const again = message({
			id: "2-WCJQSG-7-bbbbbbbb",
			text: " Who has  QEMU? ",
		});
		expect(damper.damp(again, wake, 0, at)).toEqual({
			attention: "glance",
			why: "sent to this peer, said already",
		});
		expect(damper.damp(message({ from: "P9R1KI" }), wake, 0, at)).toEqual(wake);
		expect(damper.damp(again, wake, 0, at + HOUR_MS)).toEqual(wake);
	});
});

describe("damping", () => {
	it("leaves alone what starts no turn", () => {
		const damper = createDamper();
		for (let one = 0; one < MOST_TURNS_AN_HOUR; one += 1) {
			damper.started(["WCJQSG"], at);
		}
		const note: Heed = { attention: "note", why: "about the whole machine" };
		const glance: Heed = { attention: "glance", why: "about another's work" };

		expect(damper.damp(message({ to: [ALL] }), note, 9, at)).toEqual(note);
		expect(damper.damp(message({ to: [ALL] }), glance, 9, at)).toEqual(glance);
	});
});
