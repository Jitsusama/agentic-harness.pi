/**
 * A round asks its first reviewer alone, and the rest once it has begun.
 *
 * The cache can only give a reviewer a brief another has already
 * written, and the entry becomes readable once the response that wrote
 * it begins. Measured with two reviewers sent one 64,000 token brief:
 * started together, both wrote all of it; the second started once the
 * first had begun answering read 63,950 tokens of it from the cache.
 */

import { describe, expect, it } from "vitest";
import type { AskAnswer, Participant } from "../../../lib/core/review/index.ts";
import { runCouncil, startCouncil } from "../../../lib/core/review/index.ts";

const now = () => new Date("2026-11-05T00:00:00.000Z");

/** A wait the test settles by hand. */
function gate() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { open, opened };
}

/** Lets every pending callback run, so what was going to start has. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const ANSWER: AskAnswer = { text: '{"findings": []}' };

function council(reviewers: Participant[]) {
	const asked: string[] = [];
	const answers = new Map<string, ReturnType<typeof gate>>();
	const warm = gate();
	const warmedFor: string[] = [];
	const deps = {
		now,
		record: async () => [],
		async ask(participant: Participant): Promise<AskAnswer> {
			asked.push(participant.id);
			const answer = gate();
			answers.set(participant.id, answer);
			await answer.opened;
			return ANSWER;
		},
		async warmed(participant: Participant) {
			warmedFor.push(participant.id);
			await warm.opened;
		},
	};
	const round = runCouncil(
		{ roster: { reviewers }, prompt: "brief", seq: 1 },
		deps,
	);
	const finish = async () => {
		for (const answer of answers.values()) answer.open();
		await settle();
		for (const answer of answers.values()) answer.open();
		return await round;
	};
	return { asked, answers, warm, warmedFor, finish };
}

describe("a council whose reviewers share a brief", () => {
	it("asks the first alone until its first response has begun", async () => {
		const round = council([{ id: "hawk" }, { id: "owl" }, { id: "crow" }]);

		await settle();
		expect(round.asked).toEqual(["hawk"]);
		expect(round.warmedFor).toEqual(["hawk"]);

		round.warm.open();
		await settle();
		expect(round.asked).toEqual(["hawk", "owl", "crow"]);
		await round.finish();
	});

	it("stops waiting when the first reviewer's ask ends without a response", async () => {
		// One that dies at once must not hold the round for the whole wait.
		const round = council([{ id: "hawk" }, { id: "owl" }]);
		await settle();

		round.answers.get("hawk")?.open();
		await settle();

		expect(round.asked).toEqual(["hawk", "owl"]);
		await round.finish();
	});

	it("does not hold a reviewer whose request could not share the brief", async () => {
		const round = council([
			{ id: "hawk" },
			{ id: "owl", model: "other/model" },
			{ id: "crow" },
		]);

		await settle();

		expect(round.asked).toEqual(["hawk", "owl"]);
		round.warm.open();
		await round.finish();
	});

	it("still reports the answers in roster order", async () => {
		const round = council([{ id: "hawk" }, { id: "owl" }]);
		round.warm.open();

		const { run } = await round.finish();

		expect(run.outcomes.map((one) => one.participantId)).toEqual([
			"hawk",
			"owl",
		]);
	});

	it("asks everybody at once when the round cannot tell", async () => {
		const asked: string[] = [];
		await runCouncil(
			{
				roster: { reviewers: [{ id: "hawk" }, { id: "owl" }] },
				prompt: "p",
				seq: 1,
			},
			{
				now,
				record: async () => [],
				async ask(participant) {
					asked.push(participant.id);
					await settle();
					return ANSWER;
				},
			},
		);

		expect(asked).toEqual(["hawk", "owl"]);
	});

	it("goes ahead when the wait itself fails", async () => {
		const asked: string[] = [];
		await runCouncil(
			{
				roster: { reviewers: [{ id: "hawk" }, { id: "owl" }] },
				prompt: "p",
				seq: 1,
			},
			{
				now,
				record: async () => [],
				async ask(participant) {
					asked.push(participant.id);
					await settle();
					return ANSWER;
				},
				warmed: async () => {
					throw new Error("no log");
				},
			},
		);

		expect(asked).toEqual(["hawk", "owl"]);
	});
});

describe("a detached round whose reviewers share a brief", () => {
	it("starts the rest once the first one's response has begun", async () => {
		const order: string[] = [];

		await startCouncil(
			{
				roster: { reviewers: [{ id: "hawk" }, { id: "owl" }, { id: "crow" }] },
				prompt: "brief",
				seq: 1,
			},
			{
				now,
				async start(participant) {
					order.push(`start ${participant.id}`);
				},
				async warmed(participant) {
					order.push(`warmed ${participant.id}`);
				},
			},
		);

		expect(order).toEqual([
			"start hawk",
			"warmed hawk",
			"start owl",
			"start crow",
		]);
	});

	it("waits on the first that started, not one that would not", async () => {
		const order: string[] = [];

		await startCouncil(
			{
				roster: { reviewers: [{ id: "hawk" }, { id: "owl" }, { id: "crow" }] },
				prompt: "brief",
				seq: 1,
			},
			{
				now,
				async start(participant) {
					if (participant.id === "hawk") throw new Error("no such binary");
					order.push(`start ${participant.id}`);
				},
				async warmed(participant) {
					order.push(`warmed ${participant.id}`);
				},
			},
		);

		expect(order).toEqual(["start owl", "warmed owl", "start crow"]);
	});
});
