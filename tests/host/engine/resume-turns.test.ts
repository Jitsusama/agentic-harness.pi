/**
 * The turns a host gives the runs a restart cut off: a few at once, the
 * whole start's order rather than whichever resumed first, Joel's first.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../host/engine/pi-types.ts";
import {
	beganWithPersonsWords,
	type GiveBack,
	RESUMED_RUNS_AT_ONCE,
	RESUMED_TURN_MS,
	resumeTurns,
} from "../../../host/engine/resume-turns.ts";

/** Let every settled promise's continuations run. */
async function settle(): Promise<void> {
	for (let round = 0; round < 5; round++) await Promise.resolve();
}

/** Ten carried runs asking in the order a start resumed them; the given ones began from Joel's words. */
function askTen(take: ReturnType<typeof resumeTurns>["take"], joels: number[]) {
	const started: number[] = [];
	const givers = new Map<number, GiveBack>();
	for (let run = 0; run < 10; run++) {
		void take(joels.includes(run)).then((giveBack) => {
			started.push(run);
			givers.set(run, giveBack);
		});
	}
	return { started, givers };
}

describe("turns for the runs a restart cut off", () => {
	it("starts no more than the cap of ten carried runs until one ends, Joel's first", async () => {
		const turns = resumeTurns();
		turns.hold();
		const { started, givers } = askTen(turns.take, [6, 8]);
		await settle();
		expect(started, "nothing goes while the start still resumes").toEqual([]);
		turns.open();
		await settle();
		expect(RESUMED_RUNS_AT_ONCE).toBe(4);
		expect(
			started,
			"the two Joel's words began go first, then the rest in the order they asked",
		).toEqual([6, 8, 0, 1]);
		expect(turns.going()).toBe(4);
		givers.get(8)?.();
		givers.get(8)?.();
		await settle();
		expect(
			started,
			"one ending lets exactly one more go, however often it says so",
		).toEqual([6, 8, 0, 1, 2]);
		for (const run of [6, 0, 1, 2]) givers.get(run)?.();
		await settle();
		expect(started).toEqual([6, 8, 0, 1, 2, 3, 4, 5, 7]);
	});

	describe("a run busy past its turn", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("gives its turn back by itself, so it never holds up the fifth", async () => {
			vi.useFakeTimers();
			const turns = resumeTurns();
			const { started, givers } = askTen(turns.take, []);
			await settle();
			expect(started).toEqual([0, 1, 2, 3]);
			vi.advanceTimersByTime(RESUMED_TURN_MS - 1);
			await settle();
			expect(started, "a turn stays lent until its time is up").toEqual([
				0, 1, 2, 3,
			]);
			vi.advanceTimersByTime(1);
			await settle();
			expect(
				started,
				"the four still busy hold no turn past their time",
			).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
			expect(turns.going()).toBe(4);
			givers.get(0)?.();
			await settle();
			expect(
				started,
				"a run ending after its time gives back nothing more",
			).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
			givers.get(4)?.();
			await settle();
			expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		});
	});

	it("goes at once outside a start, up to the cap", async () => {
		const turns = resumeTurns(2);
		const { started } = askTen(turns.take, []);
		await settle();
		expect(started).toEqual([0, 1]);
	});

	it("ends an aborted wait at once, with a turn that counts for nothing", async () => {
		const turns = resumeTurns(1);
		const held = await turns.take(false);
		const stop = new AbortController();
		const waited = turns.take(false, stop.signal);
		let next = false;
		void turns.take(false).then(() => {
			next = true;
		});
		stop.abort();
		const nothing = await waited;
		nothing();
		await settle();
		expect(next, "the aborted wait gave back no turn it never had").toBe(false);
		held();
		await settle();
		expect(next, "the next waiting run goes once the turn is back").toBe(true);
	});
});

describe("whether a cut-off turn began from a person's words", () => {
	const user = (content: AgentMessage["content"]): AgentMessage => ({
		role: "user",
		content,
	});
	const answer: AgentMessage = { role: "assistant", content: [] };

	it("reads the newest user message, past the answers after it", () => {
		expect(
			beganWithPersonsWords([user("hi"), answer, answer]),
			"words typed began it",
		).toBe(true);
		expect(
			beganWithPersonsWords([
				user("hi"),
				answer,
				user([
					{
						type: "text",
						text: "[Automated message, no human input: background work is reporting.] done",
					},
				]),
				answer,
			]),
			"a turn the harness started began it",
		).toBe(false);
	});

	it("says no for a conversation with no user message", () => {
		expect(beganWithPersonsWords([answer]), "nobody wrote in it").toBe(false);
	});
});
