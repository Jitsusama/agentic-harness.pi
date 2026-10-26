/**
 * Damping: a peer's limits on the attention messages deserve.
 */
import { describe, expect, it } from "vitest";
import type { Heed } from "../../../lib/mesh/attention.ts";
import {
	caughtUp,
	createDamper,
	HOUR_MS,
	MOST_CAUGHT_UP,
	MOST_IN_FULL_FROM_ONE,
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

const turn: Heed = { attention: "turn", why: "sent to this peer" };
const act: Heed = { attention: "act", why: "sent to this peer" };
const at = 10 * HOUR_MS;

describe("a peer's turns", () => {
	it("stop being started by one sender past its share of the hour", () => {
		const damper = createDamper();
		for (let one = 0; one < MOST_TURNS_FROM_ONE; one += 1) {
			damper.started(["WCJQSG"], at);
		}

		expect(damper.damp(message(), turn, 0, at)).toEqual({
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
		const awaited: Heed = { ...turn, awaited: true };

		expect(damper.damp(message(), awaited, 1, at)).toEqual(awaited);
		expect(
			damper.damp(message(), awaited, MOST_REPLY_DEPTH + 1, at).attention,
		).toBe("note");
		damper.handed([message()], at);
		const said = message({ id: "2-WCJQSG-7-bbbbbbbb" });
		expect(damper.damp(said, awaited, 1, at).attention).toBe("glance");
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

		expect(damper.damp(message(), turn, 0, at + HOUR_MS).attention).toBe(
			"turn",
		);
	});

	it("are never started by an answer too deep in its thread", () => {
		const damper = createDamper();
		expect(damper.damp(message(), turn, MOST_REPLY_DEPTH, at)).toEqual(turn);
		expect(damper.damp(message(), turn, MOST_REPLY_DEPTH + 1, at)).toEqual({
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

		expect(damper.damp(message(), turn, 0, at).attention).toBe("note");
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
		expect(damper.damp(again, turn, 0, at)).toEqual({
			attention: "glance",
			why: "sent to this peer, said already",
		});
		expect(damper.damp(message({ from: "P9R1KI" }), turn, 0, at)).toEqual(turn);
		expect(damper.damp(again, turn, 0, at + HOUR_MS)).toEqual(turn);
	});

	it("is not the same message handed again, as one let go comes back", () => {
		const damper = createDamper();
		damper.recover([], [{ at, from: "P9R1KI", text: "why?", id: "3-P9R1KI" }]);
		damper.handed([message()], at);

		expect(damper.damp(message(), act, 0, at)).toEqual(act);
		const back = message({ id: "3-P9R1KI", from: "P9R1KI", text: "why?" });
		expect(damper.damp(back, act, 0, at)).toEqual(act);
	});
});

describe("a sender's news", () => {
	const note: Heed = { attention: "note", why: "about this peer's work" };
	const fyi = (over: Partial<Message> = {}) =>
		message({ id: "9-WCJQSG-7-ffffffff", intent: "fyi", ...over });
	const many = (from: string) =>
		Array.from({ length: MOST_IN_FULL_FROM_ONE }, (_, one) =>
			message({ id: `${one}-${from}-7-aaaaaaaa`, from, text: `n${one}` }),
		);

	it("is a glance once its sender has had the hour's in full", () => {
		const damper = createDamper();
		damper.handed(many("WCJQSG").slice(1), at);

		expect(damper.damp(fyi(), note, 0, at)).toEqual(note);
		damper.handed(many("WCJQSG").slice(0, 1), at);
		expect(damper.damp(fyi(), note, 0, at)).toEqual({
			attention: "glance",
			why: "about this peer's work, the hour's news from WCJQSG spent",
		});
		expect(damper.damp(fyi({ from: "P9R1KI" }), note, 0, at)).toEqual(note);
		expect(damper.damp(fyi({ intent: "question" }), note, 0, at)).toEqual(note);
		const awaited: Heed = { ...note, awaited: true };
		expect(damper.damp(fyi(), awaited, 0, at)).toEqual(awaited);
		expect(damper.damp(fyi(), note, 0, at + HOUR_MS)).toEqual(note);
	});

	it("counts what came before it in the same arrival, and each message once", () => {
		const damper = createDamper();
		const once = many("WCJQSG")[0] as Message;
		damper.handed(
			Array.from({ length: MOST_IN_FULL_FROM_ONE }, () => once),
			at,
		);

		expect(damper.damp(fyi(), note, 0, at)).toEqual(note);
		expect(damper.damp(fyi(), note, 0, at, many("WCJQSG")).attention).toBe(
			"glance",
		);
	});
});

describe("a long catch-up", () => {
	it("hands over in full only its newest, and what is the peer's own", () => {
		const note: Heed = { attention: "note", why: "about this peer's work" };
		const glance: Heed = { attention: "glance", why: "an fyi past its hour" };
		const caught = Array.from({ length: MOST_CAUGHT_UP + 5 }, (_, one) => ({
			message: message({ id: `${one}-WCJQSG-7-aaaaaaaa` }),
			heed: one === 1 ? glance : note,
			own: one === 0,
		}));

		const older = {
			attention: "glance",
			why: `${note.why}, older in a long catch-up`,
		};
		expect(caughtUp(caught)).toEqual([
			note,
			glance,
			older,
			older,
			older,
			...Array.from({ length: MOST_CAUGHT_UP }, () => note),
		]);
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
