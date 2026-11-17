/**
 * When a message starts a turn: a question to an idle peer, news that
 * starts none, an act once the mesh settles, how damping and asking
 * again pace them, and what a peer woken from a park reads.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GLANCE, NOTED } from "../../../extensions/mesh-workflow/delivery.ts";
import { reloadSlot } from "../../../lib/internal/reload/slot.ts";
import { SESSION_WOKEN } from "../../../lib/internal/session/park.ts";
import {
	fromElsewhere,
	judging,
	notYours,
	peer,
	type Sent,
	session,
	startSession,
} from "./support/mesh.ts";

describe("a turn", () => {
	it("starts a turn at once for a question to an idle peer, and for nothing that asks nothing", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });

		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: true });

		fromElsewhere({ intent: "fyi", to: ["@7M6JKG"], text: "done here" });
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[1]?.options).toEqual({ triggerTurn: false });
	});

	it("leaves a question's turn to the first prompt pi was started with, while it has yet to run", async () => {
		// A turn started before pi submits its command line's words takes
		// their place, and pi refuses them (Y2YBTS [6508f771]).
		const argv = process.argv;
		process.argv = [argv[0] ?? "node", "pi", "--", "Carry on"];
		const uptime = vi.spyOn(process, "uptime").mockReturnValue(5);
		delete (globalThis as Record<symbol, unknown>)[
			Symbol.for("agentic-harness.pi/first-prompt")
		];
		try {
			const { sent } = await startSession({}, { isIdle: () => true });

			fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });
			await vi.waitFor(() => expect(sent).toHaveLength(1));
			expect(sent[0]?.options).toEqual({ triggerTurn: false });
		} finally {
			process.argv = argv;
			uptime.mockRestore();
		}
	});

	it("puts a question's turn off for a waiting reload, owing it to the landing", async () => {
		const slot = reloadSlot();
		slot.request = { reason: "the install moved", by: "self" };
		try {
			const { sent } = await startSession({}, { isIdle: () => true });

			fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });

			await vi.waitFor(() => expect(sent).toHaveLength(1));
			expect(sent[0]?.options).toEqual({ triggerTurn: false });
			expect(JSON.stringify(sent[0]?.message)).toContain("why?");
			expect(slot).toMatchObject({ turnOwed: true });
		} finally {
			slot.request = undefined;
			slot.turnOwed = undefined;
		}
	});

	it("leaves what it catches up on at start to the first prompt it was started with", async () => {
		const argv = process.argv;
		process.argv = [argv[0] ?? "node", "pi", "--", "Carry on"];
		const uptime = vi.spyOn(process, "uptime").mockReturnValue(5);
		delete (globalThis as Record<symbol, unknown>)[
			Symbol.for("agentic-harness.pi/first-prompt")
		];
		try {
			fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });

			const { sent } = await startSession({}, { isIdle: () => true });

			await vi.waitFor(() => expect(sent).toHaveLength(1));
			expect(sent[0]?.options).toEqual({ triggerTurn: false });
		} finally {
			process.argv = argv;
			uptime.mockRestore();
		}
	});

	it("takes a turn for a question waiting as it starts with no first prompt, as a woken parked peer does", async () => {
		const argv = process.argv;
		process.argv = [argv[0] ?? "node", "pi", "--session", "/logs/s.jsonl"];
		try {
			fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });

			const { sent } = await startSession({}, { isIdle: () => true });

			await vi.waitFor(() => expect(sent).toHaveLength(1));
			expect(sent[0]?.options).toEqual({ triggerTurn: true });
			expect(JSON.stringify(sent[0]?.message)).toContain("why?");
		} finally {
			process.argv = argv;
		}
	});

	it("reads, woken from a park, what was handed over since its last turn", async () => {
		const argv = process.argv;
		process.argv = [argv[0] ?? "node", "pi", "--session", "/logs/s.jsonl"];
		try {
			const { sent } = await startSession(
				{},
				{ isIdle: () => true },
				unreadSinceLastTurn(),
				undefined,
				undefined,
				(early) => early(SESSION_WOKEN, { session }),
			);

			await vi.waitFor(() => expect(sent).toHaveLength(1));
			expect(sent[0]?.options).toEqual({ triggerTurn: true });
			expect(sent[0]?.message.content).toContain("Woken from parking");
		} finally {
			process.argv = argv;
		}
	});

	it("reads what waited when parking says it woke after the mesh started", async () => {
		const argv = process.argv;
		process.argv = [argv[0] ?? "node", "pi", "--session", "/logs/s.jsonl"];
		try {
			const { sent, emit } = await startSession(
				{},
				{ isIdle: () => true },
				unreadSinceLastTurn(),
			);
			await new Promise((settle) => setTimeout(settle, 100));
			expect(sent).toEqual([]);

			emit(SESSION_WOKEN, { session });

			await vi.waitFor(() => expect(sent).toHaveLength(1));
			expect(sent[0]?.options).toEqual({ triggerTurn: true });
		} finally {
			process.argv = argv;
		}
	});

	it("takes no turn, woken, when its last turn read everything", async () => {
		const argv = process.argv;
		process.argv = [argv[0] ?? "node", "pi", "--session", "/logs/s.jsonl"];
		try {
			const { sent } = await startSession(
				{},
				{ isIdle: () => true },
				[...unreadSinceLastTurn(), assistantEntry()],
				undefined,
				undefined,
				(early) => early(SESSION_WOKEN, { session }),
			);
			await new Promise((settle) => setTimeout(settle, 100));

			expect(sent).toEqual([]);
		} finally {
			process.argv = argv;
		}
	});
});

/** A model's answer, as the session's branch holds one. */
function assistantEntry() {
	return {
		type: "message",
		id: "a1",
		timestamp: new Date(0).toISOString(),
		message: { role: "assistant", content: [] },
	};
}

/** A branch whose last answer was followed by a mesh note no turn read. */
function unreadSinceLastTurn() {
	return [
		assistantEntry(),
		{
			type: "custom_message",
			id: "m1",
			timestamp: new Date(0).toISOString(),
			customType: NOTED,
			content: "From 4UHC5Q, a finding: your node socket moved",
			display: true,
		},
	];
}

describe("news for an idle peer", () => {
	// On 2026-11-03, 764 of 1,518 messages reaching a peer started a turn,
	// and 287 of those turns did nothing but acknowledge (P9R1KI
	// [6bdab129]). What asks nothing waits for the turn something else
	// starts, which pi's own rules hand it: appended while idle, it is in
	// the context that turn reads.
	it("puts an fyi or a finding sent to it in without starting a turn", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });

		fromElsewhere({ intent: "fyi", to: ["@7M6JKG"], text: "merged #950" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		fromElsewhere({ intent: "finding", to: ["@7M6JKG"], text: "your bug" });
		await vi.waitFor(() => expect(sent).toHaveLength(2));

		expect(sent.map(({ options }) => options)).toEqual([
			{ triggerTurn: false },
			{ triggerTurn: false },
		]);
		expect(sent[0]?.message.content).toContain("merged #950");
		expect(sent[1]?.message.content).toContain("your bug");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sent).toHaveLength(2);
	});

	it("puts a finding about its work in without starting a turn", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });

		fromElsewhere({ intent: "finding", text: "7M6JKG drops a lease" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message.details).toMatchObject({
			why: ["about this peer's work"],
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sent).toHaveLength(1);
	});

	it("still starts a turn for a question put to it after the news", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });

		fromElsewhere({ intent: "finding", to: ["@7M6JKG"], text: "your bug" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });
		await vi.waitFor(() => expect(sent).toHaveLength(2));

		expect(sent[1]?.options).toEqual({ triggerTurn: true });
		expect(sent[1]?.message.content).toContain("why?");
		expect(sent[1]?.message.content).not.toContain("your bug");
	});
});

describe("an act", () => {
	it("starts one turn for questions about an idle peer's work once the mesh settles", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });

		fromElsewhere({ intent: "question", text: "can 7M6JKG fix its bug?" });
		fromElsewhere({ intent: "question", text: "and 7M6JKG's other one?" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: true });
		expect(sent[0]?.message.content).toContain("its bug");
		expect(sent[0]?.message.content).toContain("other one");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sent).toHaveLength(1);
	});

	it("goes with a run something else starts first, and starts none", async () => {
		const { sent, fire } = await startSession({}, { isIdle: () => true }, [], {
			settleMs: 400,
			spreadMs: 0,
		});

		fromElsewhere({ intent: "question", text: "7M6JKG: your bug?" });
		// Long enough to be waiting, well short of the turn it waits for.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const opened = (await fire("before_agent_start")) as
			| { message?: Sent["message"] }
			| undefined;

		expect(opened?.message?.customType).toBe(NOTED);
		expect(opened?.message?.content).toContain("your bug");
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(sent).toEqual([]);
	});

	it("waits through a run carried on after a restart, whose message pi holds for the next prompt", async () => {
		// A host's carried run begins with nobody's words, and pi gives its handlers' messages only to the prompt after it: taken then, an act was handed over and never seen.
		const { fire } = await startSession({}, { isIdle: () => true }, [], {
			settleMs: 400,
			spreadMs: 0,
		});

		fromElsewhere({ intent: "question", text: "7M6JKG: your bug?" });
		// Long enough for the question to be waiting, well short of its 400 ms settle.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const carried = await fire("before_agent_start", {
			messageType: "continue",
		});
		const typed = (await fire("before_agent_start", {
			messageType: "user",
			prompt: "hello",
		})) as { message?: Sent["message"] } | undefined;

		expect(carried, "the carried run took nothing").toBeUndefined();
		expect(typed?.message?.customType).toBe(NOTED);
		expect(typed?.message?.content).toContain("your bug");
	});

	it("starts no turn for a group's question another peer answered meanwhile", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });

		const asked = fromElsewhere({
			intent: "question",
			text: "who can look at 7M6JKG's tests?",
		});
		fromElsewhere({
			from: "P9R1KI",
			to: ["@WCJQSG"],
			re: asked.id,
			text: "on it",
		});

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message.details).toMatchObject({
			why: ["about this peer's work, answered already"],
		});
	});

	it("asks no classifier about what names this peer", async () => {
		const calls: unknown[] = [];
		const { sent } = await startSession({}, judging(notYours, calls));

		fromElsewhere({ text: "7M6JKG: your reload broke mine" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.customType).toBe(NOTED);
		expect(calls).toEqual([]);
	});
});

describe("damping", () => {
	it("starts a turn for every question put to this peer, however many", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });
		const many = 13;

		for (let one = 1; one <= many; one += 1) {
			fromElsewhere({
				intent: "question",
				to: ["@7M6JKG"],
				text: `why ${one}?`,
			});
			await vi.waitFor(() => expect(sent).toHaveLength(one));
		}

		expect(sent.map((one) => one.options)).toEqual(
			Array.from({ length: many }, () => ({ triggerTurn: true })),
		);
	});

	it("steers a question put to a busy peer into its run", async () => {
		const { sent } = await startSession({}, { isIdle: () => false });

		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });
		fromElsewhere({ to: ["@7M6JKG"], text: "rebooting at 01:00" });

		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent.map((one) => one.options)).toEqual([
			{ triggerTurn: true },
			{ triggerTurn: false },
		]);
	});

	it("glances at what a sender said already", async () => {
		const { sent, entries } = await startSession();

		fromElsewhere({ to: ["@7M6JKG"], text: "rebooting at 01:00" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		fromElsewhere({ to: ["@7M6JKG"], text: "Rebooting at 01:00" });

		await vi.waitFor(() => expect(entries).toHaveLength(1));
		expect(entries[0]).toMatchObject({
			type: GLANCE,
			data: { why: "sent to this peer, said already" },
		});
	});
});

describe("asking again", () => {
	const later = () => vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1000);
	afterEach(() => vi.useRealTimers());
	const start = () =>
		startSession(
			{},
			{ isIdle: () => true },
			[],
			undefined,
			undefined,
			undefined,
			20,
		);

	it("asks again, with a turn, a question put to this peer it never answered", async () => {
		const { sent } = await start();
		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "ready?" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		vi.useFakeTimers({ toFake: ["Date"] });
		later();

		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[1]?.options).toEqual({ triggerTurn: true });
		expect(sent[1]?.message.content).toMatch(/^Asked again: this question/);
		expect(sent[1]?.message.content).toContain("ready?");
	});

	it("asks nothing again while this peer's run goes on", async () => {
		// pi queues what reaches a busy session and gives it one at a time,
		// so asking again meanwhile queued reminders that arrived only after
		// the answer they asked for (WJATIN, 3 November).
		let idle = false;
		const { sent } = await startSession(
			{},
			{ isIdle: () => idle },
			[],
			undefined,
			undefined,
			undefined,
			20,
		);
		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "ready?" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		vi.useFakeTimers({ toFake: ["Date"] });
		later();
		await new Promise((done) => setTimeout(done, 100));
		expect(sent).toHaveLength(1);

		// Its run ended with no answer sent: now it is asked again.
		idle = true;
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[1]?.message.content).toMatch(/^Asked again: this question/);
	});

	it("asks nothing again once this peer has answered", async () => {
		const { sent, tools } = await start();
		peer("session-w", ["WCJQSG"], []);
		const asked = fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "ready?",
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		await tools.get("mesh_send")?.execute("call-1", {
			to: "WCJQSG",
			intent: "fyi",
			text: "yes",
			re: asked.id.slice(-8),
		});

		vi.useFakeTimers({ toFake: ["Date"] });
		later();
		await new Promise((done) => setTimeout(done, 100));

		expect(sent).toHaveLength(1);
	});

	it("tells the asker a question put by name has had no answer", async () => {
		const { sent, tools } = await start();
		peer("session-w", ["WCJQSG"], []);
		await tools.get("mesh_send")?.execute("call-1", {
			to: "WCJQSG",
			intent: "question",
			text: "is equilibrius ready again?",
		});

		vi.useFakeTimers({ toFake: ["Date"] });
		later();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message.content).toContain("has had no answer from WCJQSG");
	});
});
