/**
 * The attention a message gets from the peer it reaches: a glance, a
 * note, an act or a wake, and never none.
 */
import { describe, expect, it } from "vitest";
import {
	attend,
	concernFrom,
	concernQuestion,
	concernQuestionFor,
	concernQuestionNow,
	concernState,
	FYI_MS,
	mentions,
	type Standing,
} from "../../../lib/mesh/attention.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import { MOST_HOLD_MS } from "../../../lib/mesh/lease.ts";
import type { Message } from "../../../lib/mesh/message.ts";

function message(over: Partial<Message> = {}): Message {
	return {
		v: 1,
		id: "1-2HN63P-1-aaaa",
		at: "2026-10-22T02:22:00.000Z",
		from: "2HN63P",
		to: [ALL],
		text: "merging core.nix#330 now (modules/guide only)",
		intent: "fyi",
		pid: 1,
		...over,
	};
}

const standing: Standing = {
	receiver: {
		addresses: ["5GV2AH", "24B025FE"],
		worksOn: "Protections That Lead to Good Outcomes",
		owns: ["agentic-harness.pi", "harness", "QEST-20261021-5GV2AH"],
	},
	idle: false,
};

describe("attention", () => {
	it("glances at another peer's own business, never passing it by", () => {
		const heed = attend(message(), { ...standing, concern: "other" });
		expect(heed.attention).toBe("glance");
	});

	it("notes a hold whatever it is judged, since missing one costs someone", () => {
		const hold = message({ intent: "hold", text: "hold heavy builds 4 min" });
		expect(attend(hold, { ...standing, concern: "other" }).attention).toBe(
			"note",
		);
	});

	it("notes what it cannot judge", () => {
		expect(attend(message(), standing)).toEqual({
			attention: "note",
			why: "not judged, so noted",
		});
	});

	it("notes what is sent to this peer whatever it is judged", () => {
		const home = message({ to: ["@5GV2AH"] });
		expect(attend(home, { ...standing, concern: "other" }).attention).toBe(
			"note",
		);
	});

	it("wakes an idle peer for a question sent to it, and acts on one to a group about its work", () => {
		const asked = message({
			intent: "question",
			to: ["@5GV2AH"],
			text: "why?",
		});
		expect(attend(asked, { ...standing, idle: true }).attention).toBe("wake");
		expect(attend(asked, standing).attention).toBe("note");
		const broadcast = message({
			intent: "question",
			text: "who has a build up?",
		});
		expect(attend(broadcast, { ...standing, idle: true }).attention).toBe(
			"note",
		);
		expect(
			attend(broadcast, { ...standing, idle: true, concern: "receiver" })
				.attention,
		).toBe("act");
	});

	it("starts a turn only for questions and findings", () => {
		const idle = { ...standing, idle: true };
		const to = ["@5GV2AH"];
		expect(attend(message({ intent: "finding", to }), idle).attention).toBe(
			"act",
		);
		expect(attend(message({ intent: "hold", to }), idle).attention).toBe(
			"note",
		);
		expect(attend(message({ intent: "fyi", to }), idle).attention).toBe("note");
		expect(attend(message({ intent: "finding", to }), standing).attention).toBe(
			"note",
		);
	});

	it("takes an answer to this peer's own message as sent to it", () => {
		const answer = message({ intent: "question", re: "0-5GV2AH-1-bbbb" });
		const answering = { ...standing, answers: true, concern: "other" as const };
		expect(attend(answer, { ...answering, idle: true })).toEqual({
			attention: "wake",
			why: "answering this peer",
		});
		expect(attend(answer, answering).attention).toBe("note");
	});

	it("wakes an idle peer for an answer to its question, however it was sent", () => {
		const answer = message({ intent: "fyi", re: "0-5GV2AH-1-bbbb" });
		const asked = {
			...standing,
			answers: true,
			asked: true,
			concern: "other" as const,
		};
		expect(attend(answer, { ...asked, idle: true })).toEqual({
			attention: "wake",
			why: "answering this peer's question",
			awaited: true,
		});
		expect(attend(answer, asked)).toEqual({
			attention: "note",
			why: "answering this peer's question",
		});
	});

	it("glances at an fyi past its hour, wherever it went", () => {
		const sent = Date.parse("2026-10-22T04:00:00.000Z");
		const told = message({
			intent: "fyi",
			to: ["@5GV2AH"],
			at: "2026-10-22T04:00:00.000Z",
		});
		const held = message({ intent: "hold", at: "2026-10-22T04:00:00.000Z" });

		expect(attend(told, { ...standing, now: sent + FYI_MS + 1 })).toEqual({
			attention: "glance",
			why: "an fyi past its hour",
		});
		expect(attend(told, { ...standing, now: sent + FYI_MS }).attention).toBe(
			"note",
		);
		expect(
			attend(held, { ...standing, now: sent + 2 * FYI_MS }).attention,
		).toBe("note");
	});

	it("glances at a hold older than the longest a hold stands", () => {
		const sent = Date.parse("2026-10-22T04:00:00.000Z");
		const held = message({
			intent: "hold",
			to: ["@5GV2AH"],
			at: "2026-10-22T04:00:00.000Z",
		});

		expect(attend(held, { ...standing, now: sent + MOST_HOLD_MS + 1 })).toEqual(
			{ attention: "glance", why: "a hold past the longest one stands" },
		);
		expect(
			attend(held, { ...standing, now: sent + MOST_HOLD_MS }).attention,
		).toBe("note");
	});

	it("reads a mention of the peer or what it owns as concerning it", () => {
		// Without a classifier, so a question about the harness still wakes.
		const asked = message({
			intent: "question",
			text: "is that refusal from the Harness?",
		});
		expect(mentions(asked, standing.receiver)).toBe(true);
		expect(attend(asked, { ...standing, idle: true }).attention).toBe("act");
		expect(
			mentions(message({ text: "a 5gv2ah-ish word" }), standing.receiver),
		).toBe(true);
		expect(mentions(message(), standing.receiver)).toBe(false);
	});
});

describe("a classifier's concern", () => {
	it("trusts a sure 'not yours' and nothing less", () => {
		const other = (p: number) => ({
			type: "choice",
			choice: "other",
			probabilities: { other: p, receiver: 1 - p, machine: 0 },
		});
		expect(concernFrom(other(0.93))).toBe("other");
		expect(concernFrom(other(0.55))).toBeUndefined();
		expect(concernFrom({ type: "choice", choice: "receiver" })).toBe(
			"receiver",
		);
		expect(concernFrom({ type: "choice", choice: "nonsense" })).toBeUndefined();
		expect(concernFrom(undefined)).toBeUndefined();
	});

	it("is asked about what the peer changes now only while it changes something", () => {
		const changing = {
			...standing.receiver,
			changing: ["agentic-harness.pi:lib/mesh/attention.ts"],
		};

		expect(concernQuestionFor(changing)).toBe(concernQuestionNow);
		expect(concernQuestionFor(standing.receiver)).toBe(concernQuestion);
		expect(concernQuestionFor({ changing: [] })).toBe(concernQuestion);
		expect(concernState(message(), changing)).toMatchObject({
			receiver: { changing_now: ["agentic-harness.pi:lib/mesh/attention.ts"] },
		});
		expect(
			concernState(message(), { ...standing.receiver, changing: [] }),
		).not.toHaveProperty("receiver.changing_now");
	});

	it("reads a file the peer changes, named by its path, as concerning it", () => {
		const changing = {
			...standing.receiver,
			changing: ["widget:src/queue.ts", "widget:flake.nix"],
		};

		expect(mentions(message({ text: "src/queue.ts is wrong" }), changing)).toBe(
			true,
		);
		// A file every checkout has does not say which work it is.
		expect(mentions(message({ text: "bumped flake.nix" }), changing)).toBe(
			false,
		);
		expect(mentions(message(), changing)).toBe(false);
	});
});
