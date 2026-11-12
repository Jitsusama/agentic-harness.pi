/**
 * The attention a message gets from the peer it reaches: a glance, a
 * note, an act or a turn, and never none.
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
import { INTENTS, type Message } from "../../../lib/mesh/message.ts";
import { orchestrationGroup } from "../../../lib/mesh/scope.ts";

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

/**
 * The receiver standing every way that changes what a message gets:
 * idle or busy, whatever it judged, answered, asked, asked of each, and
 * with the sender as its orchestrator or not.
 */
function everyStanding(): Standing[] {
	const flags = [false, true];
	const concerns = [undefined, "receiver", "machine", "other"] as const;
	return flags.flatMap((idle) =>
		concerns.flatMap((concern) =>
			flags.flatMap((answers) =>
				flags.flatMap((asked) =>
					flags.flatMap((askedEach) =>
						flags.map((orchestrated) => ({
							...standing,
							idle,
							concern,
							answers,
							asked,
							askedEach,
							orchestrator: orchestrated ? ["2HN63P"] : undefined,
						})),
					),
				),
			),
		),
	);
}

describe("attention", () => {
	it("glances at an fyi restating what its sender's presence says it landed", () => {
		const sent = message({ to: ["5GV2AH"] });
		const idle = { ...standing, idle: true, concern: "receiver" as const };

		expect(attend(sent, { ...idle, restates: true })).toMatchObject({
			attention: "glance",
			why: "status its sender's presence already carries",
		});
		expect(attend(sent, idle).attention).toBe("note");
	});

	it("still hears a restating fyi that answers it, and anything not an fyi", () => {
		const restating = { ...standing, restates: true };

		expect(attend(message(), { ...restating, answers: true }).attention).toBe(
			"note",
		);
		const finding = message({ intent: "finding" });
		const idle = { ...standing, idle: true, concern: "receiver" as const };
		expect(attend(finding, { ...idle, restates: true })).toEqual(
			attend(finding, idle),
		);
		expect(attend(finding, idle).attention).toBe("note");
	});

	it("acts, idle, on what a session it leads finds or lands, landing named or not", () => {
		const idle = { ...standing, idle: true, led: true };
		const finding = message({ intent: "finding", to: ["@5GV2AH"] });
		const landed = message({ to: ["@5GV2AH"], text: "#920 is merged" });

		expect(attend(finding, idle)).toEqual({
			attention: "act",
			why: "a finding from a session it leads",
		});
		expect(attend(landed, { ...idle, restates: true })).toEqual({
			attention: "act",
			why: "news from a session it leads",
		});
	});

	it("leaves a led session's news to the run under way, or to a group's readers", () => {
		const led = { ...standing, led: true };
		const finding = message({ intent: "finding", to: ["@5GV2AH"] });

		expect(attend(finding, led).attention).toBe("note");
		expect(
			attend(message({ intent: "finding" }), { ...led, idle: true }).attention,
		).not.toBe("act");
		expect(
			attend(message({ to: ["@5GV2AH"] }), { ...led, restates: true })
				.attention,
		).toBe("glance");
	});

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

	it("gives a peer a turn for a question sent to it, busy or not, and acts on one to a group about its work", () => {
		const asked = message({
			intent: "question",
			to: ["@5GV2AH"],
			text: "why?",
		});
		const put = {
			attention: "turn",
			why: "sent to this peer",
			addressed: true,
		};
		expect(attend(asked, { ...standing, idle: true })).toEqual(put);
		expect(attend(asked, standing)).toEqual(put);
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

	it("gives a member a turn for a question that asks each, busy or not, whatever it is judged", () => {
		const group = message({
			intent: "question",
			to: ["#optimus/done"],
			text: "each of you: what's left in your part?",
		});
		const each = { ...standing, askedEach: true, concern: "other" as const };
		const put = {
			attention: "turn",
			why: "asked of each peer it went to",
			addressed: true,
		};
		expect(attend(group, { ...each, idle: true })).toEqual(put);
		expect(attend(group, each)).toEqual(put);
	});

	it("starts a turn only for questions and holds, never for an fyi or a finding", () => {
		const idle = { ...standing, idle: true };
		const to = ["@5GV2AH"];
		expect(attend(message({ intent: "finding", to }), idle).attention).toBe(
			"note",
		);
		expect(attend(message({ intent: "hold", to }), idle).attention).toBe(
			"turn",
		);
		expect(attend(message({ intent: "hold", to }), standing).attention).toBe(
			"turn",
		);
		expect(attend(message({ intent: "fyi", to }), idle).attention).toBe("note");
		expect(attend(message({ intent: "finding", to }), standing).attention).toBe(
			"note",
		);
	});

	it("notes a finding about an idle peer's work, waiting for its next turn", () => {
		const finding = message({
			intent: "finding",
			text: "the harness drops a lease",
		});
		const idle = { ...standing, idle: true };

		expect(attend(finding, { ...idle, concern: "receiver" })).toEqual({
			attention: "note",
			why: "about this peer's work",
		});
		expect(attend(finding, idle).attention).toBe("note");
		expect(
			attend(message({ intent: "finding" }), { ...idle, answers: true })
				.attention,
		).toBe("note");
	});

	it("starts a turn for nothing but a question unless it is put to this peer or awaited", () => {
		// Damping's hour turn caps held back only what was neither: once a
		// finding stopped acting (2026-11-03), nothing reached them, and they
		// went. A turn for anything else would come back uncapped.
		const messages = INTENTS.filter((intent) => intent !== "question").flatMap(
			(intent) =>
				[[ALL], ["@5GV2AH"]].flatMap((to) =>
					["the harness drops a lease", "merging core"].map((text) =>
						message({ intent, to, text }),
					),
				),
		);
		const standings = everyStanding();

		const uncapped = messages.flatMap((sent) =>
			standings
				.map((at) => ({ at, heed: attend(sent, at) }))
				.filter(
					({ heed }) =>
						(heed.attention === "act" || heed.attention === "turn") &&
						!heed.addressed &&
						!heed.awaited,
				)
				.map(
					({ at, heed }) =>
						`${sent.intent} to ${sent.to} "${sent.text}", ${heed.attention} when ${JSON.stringify({ ...at, receiver: undefined })}`,
				),
		);

		expect(standings).toHaveLength(128);
		expect(uncapped).toEqual([]);
	});

	it("takes an answer to this peer's own message as sent to it", () => {
		const answer = message({ intent: "question", re: "0-5GV2AH-1-bbbb" });
		const answering = { ...standing, answers: true, concern: "other" as const };
		expect(attend(answer, { ...answering, idle: true })).toEqual({
			attention: "turn",
			why: "answering this peer",
		});
		expect(attend(answer, answering).attention).toBe("note");
	});

	it("gives a peer a turn for an answer to its question, busy or not, however it was sent", () => {
		const answer = message({ intent: "fyi", re: "0-5GV2AH-1-bbbb" });
		const asked = {
			...standing,
			answers: true,
			asked: true,
			concern: "other" as const,
		};
		expect(attend(answer, { ...asked, idle: true })).toEqual({
			attention: "turn",
			why: "answering this peer's question",
			awaited: true,
		});
		expect(attend(answer, asked)).toEqual({
			attention: "turn",
			why: "answering this peer's question",
			awaited: true,
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
		).toBe("turn");
	});

	it("reads a mention of the peer or what it owns as concerning it", () => {
		// Without a classifier, so a question about the harness still gets a turn.
		const asked = message({
			intent: "question",
			text: "is that refusal from the Harness?",
		});
		expect(
			mentions(asked, standing.receiver),
			"a question naming the harness mentions the peer that owns it",
		).toBe(true);
		expect(attend(asked, { ...standing, idle: true }).attention).toBe("act");
		expect(
			mentions(message({ text: "a 5gv2ah-ish word" }), standing.receiver),
			"a word holding the peer's address mentions it",
		).toBe(true);
		expect(
			mentions(message(), standing.receiver),
			"a message naming nothing of the peer's does not mention it",
		).toBe(false);
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

		expect(
			mentions(message({ text: "src/queue.ts is wrong" }), changing),
			"naming a file the peer changes mentions it",
		).toBe(true);
		// A file every checkout has does not say which work it is.
		expect(
			mentions(message({ text: "bumped flake.nix" }), changing),
			"naming a file every checkout has does not mention the peer",
		).toBe(false);
		expect(
			mentions(message(), changing),
			"a message naming none of the peer's files does not mention it",
		).toBe(false);
	});
});

/**
 * A peer whose quest hears only what is put to it, as Joel's router
 * does: it is in its orchestration's group by lineage, and every other
 * session's landings there would otherwise sit in its context and be
 * read again with each line he says.
 */
describe("a peer that hears only what is put to it", () => {
	const ROUTER = ["8GYNJ6", "E9DE8111"];
	const ORCHESTRATOR = "WCJQSG";
	const news = (over: Partial<Message> = {}): Message =>
		message({
			id: "1-5FWIUS-1-aaaa",
			at: "2026-11-12T07:40:00.000Z",
			from: "5FWIUS",
			to: [orchestrationGroup(ORCHESTRATOR)],
			text: "merged core.nix #3570, the void's disk guard",
			...over,
		});
	const router = (
		hears: "addressed" | undefined,
		over: Partial<Standing> = {},
	): Standing => ({
		receiver: {
			addresses: ROUTER,
			worksOn: "The Void: Say It Once, It Goes Where It Belongs",
			owns: ["QEST-20261112-8GYNJ6", "void"],
			...(hears ? { hears } : {}),
		},
		idle: true,
		orchestrator: [ORCHESTRATOR],
		...over,
	});
	/** What each message gets from a peer standing so. */
	const heard = (
		hears: "addressed" | undefined,
		cases: readonly [Partial<Message>, Partial<Standing>?][],
	) =>
		cases.map(([over, at]) => attend(news(over), router(hears, at)).attention);
	const overheard: [Partial<Message>, Partial<Standing>?][] = [
		[{}],
		[{}, { concern: "receiver" }],
		[{ intent: "finding" }],
		[{ intent: "question" }, { concern: "receiver" }],
		[{ intent: "pivot", from: "P0THER" }],
	];

	it("hears other peers' news about its work in full without the setting", () => {
		expect(heard(undefined, overheard), "noted, or acted on").toEqual([
			"note",
			"note",
			"note",
			"act",
			"note",
		]);
	});

	it("glances at what went to a group, however it is judged", () => {
		expect(heard("addressed", overheard), "each a glance").toEqual([
			"glance",
			"glance",
			"glance",
			"glance",
			"glance",
		]);
	});

	it("still hears what is put to it, answers it, holds or pivots it", () => {
		expect(
			heard("addressed", [
				[{ to: ["@8GYNJ6"], intent: "question" }],
				[{ to: ["@E9DE8111"] }],
				[{}, { answers: true }],
				[{}, { asked: true }],
				[{ intent: "hold" }],
				[{ intent: "pivot", from: ORCHESTRATOR }],
				[{ text: "8GYNJ6: where did that line go?" }],
			]),
			"a turn, a note, a note, a turn, a note, a turn, a note",
		).toEqual(["turn", "note", "note", "turn", "note", "turn", "note"]);
	});
});
