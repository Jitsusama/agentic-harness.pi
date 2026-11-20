/**
 * The turns a host gives the runs a restart cut off: a few at once, the
 * whole start's order rather than whichever resumed first, Joel's first.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { steerText } from "../../../extensions/mesh-workflow/steer.ts";
import type { AgentMessage } from "../../../host/engine/pi-types.ts";
import {
	beganWithPersonsWords,
	type GiveBack,
	isJoelsWords,
	LOOK_AGAIN_MS,
	RESUMED_RUNS_AT_ONCE,
	RESUMED_TURN_MS,
	resumeTurns,
} from "../../../host/engine/resume-turns.ts";
import { FROM_MACHINE } from "../../../lib/mesh/steer.ts";

/** Let every settled promise's continuations run. */
async function settle(): Promise<void> {
	for (let round = 0; round < 5; round++) await Promise.resolve();
}

/**
 * Ten carried runs asking in the order a start resumed them: `joels`
 * began from Joel's words, and `typing` he has typed into since, either
 * of which may grow as they wait.
 */
function askTen(
	take: ReturnType<typeof resumeTurns>["take"],
	joels: number[],
	typing: number[] = [],
) {
	const started: number[] = [];
	const givers = new Map<number, GiveBack>();
	for (let run = 0; run < 10; run++) {
		const waits = () =>
			typing.includes(run) ? "typing" : joels.includes(run) ? "began" : "not";
		void take(waits).then((giveBack) => {
			started.push(run);
			givers.set(run, giveBack);
		});
	}
	return { started, givers };
}

describe("turns for the runs a restart cut off", () => {
	it("lets only Joel's runs go while a start holds, then the cap of the rest in order", async () => {
		const turns = resumeTurns();
		turns.hold();
		const { started, givers } = askTen(turns.take, [6, 8]);
		await settle();
		expect(
			started,
			"only the runs Joel waits on go while the start still resumes",
		).toEqual([6, 8]);
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

	it("moves a waiting run up once Joel types into it", async () => {
		// A run only harness words began waited behind every other, even as Joel typed into it (#1593's gap).
		const turns = resumeTurns(1);
		const typing: number[] = [];
		const { started, givers } = askTen(turns.take, [], typing);
		await settle();
		expect(started).toEqual([0]);
		typing.push(7);
		givers.get(0)?.();
		await settle();
		expect(
			started,
			"the run Joel typed into goes next, ahead of those that asked before it",
		).toEqual([0, 7]);
	});

	describe("a run Joel types into while the start still resumes", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("gets its turn within a look, while the rest wait for the start", async () => {
			// On 19 November Joel's words waited 7 minutes behind a start resuming 84 conversations.
			vi.useFakeTimers();
			const turns = resumeTurns();
			turns.hold();
			const typing: number[] = [];
			const { started } = askTen(turns.take, [], typing);
			await settle();
			expect(started).toEqual([]);
			typing.push(7);
			vi.advanceTimersByTime(LOOK_AGAIN_MS);
			await settle();
			expect(started, "the run Joel typed into goes on the next look").toEqual([
				7,
			]);
			vi.advanceTimersByTime(LOOK_AGAIN_MS * 10);
			await settle();
			expect(started, "the rest still wait for the start").toEqual([7]);
			turns.open();
			await settle();
			expect(started).toEqual([7, 0, 1, 2]);
		});

		it("goes ahead of a run begun by his words, which goes ahead of the rest", async () => {
			vi.useFakeTimers();
			const turns = resumeTurns();
			turns.hold();
			const typing: number[] = [];
			const { started, givers } = askTen(turns.take, [0, 1, 2, 3, 4], typing);
			await settle();
			expect(started, "the cap holds while the start does").toEqual([
				0, 1, 2, 3,
			]);
			typing.push(7);
			vi.advanceTimersByTime(LOOK_AGAIN_MS);
			await settle();
			expect(
				started,
				"the run he types into goes on the next look, past the cap, ahead of the one begun before",
			).toEqual([0, 1, 2, 3, 7]);
			expect(turns.going()).toBe(5);
			givers.get(0)?.();
			await settle();
			expect(
				started,
				"a turn given back while past the cap lets nothing more go",
			).toEqual([0, 1, 2, 3, 7]);
			givers.get(1)?.();
			await settle();
			expect(
				started,
				"once under the cap, the run his words began goes, while the rest still wait",
			).toEqual([0, 1, 2, 3, 7, 4]);
			givers.get(2)?.();
			await settle();
			expect(started, "none of the rest goes while the start holds").toEqual([
				0, 1, 2, 3, 7, 4,
			]);
		});

		it("stops looking as the last waiting run is aborted", async () => {
			vi.useFakeTimers();
			const turns = resumeTurns();
			turns.hold();
			const stop = new AbortController();
			const waited = turns.take(() => "not", stop.signal);
			await settle();
			expect(vi.getTimerCount(), "one look while a run waits").toBe(1);
			stop.abort();
			await waited;
			expect(vi.getTimerCount(), "no look once nothing waits").toBe(0);
		});

		it("lets a run Joel types into go past a full cap outside a start too", async () => {
			vi.useFakeTimers();
			const turns = resumeTurns(2);
			const typing: number[] = [];
			const { started } = askTen(turns.take, [], typing);
			await settle();
			expect(started).toEqual([0, 1]);
			typing.push(5);
			vi.advanceTimersByTime(LOOK_AGAIN_MS);
			await settle();
			expect(started, "it goes on the next look").toEqual([0, 1, 5]);
		});

		it("stops looking once the start opens the turns to every run waiting", async () => {
			vi.useFakeTimers();
			const turns = resumeTurns(10);
			turns.hold();
			const { started } = askTen(turns.take, []);
			await settle();
			expect(vi.getTimerCount(), "one look while runs wait").toBe(1);
			turns.open();
			await settle();
			expect(started).toHaveLength(10);
			expect(
				vi.getTimerCount(),
				"only the ten lent turns' own times, and no look, once nothing waits",
			).toBe(10);
		});

		it("stops looking once it grants the last waiting run", async () => {
			vi.useFakeTimers();
			const turns = resumeTurns();
			turns.hold();
			let typed = false;
			const taken = turns.take(() => (typed ? "typing" : "not"));
			await settle();
			expect(vi.getTimerCount(), "one look while it waits").toBe(1);
			typed = true;
			vi.advanceTimersByTime(LOOK_AGAIN_MS);
			await taken;
			expect(
				vi.getTimerCount(),
				"only the lent turn's own time, and no look, once nothing waits",
			).toBe(1);
		});
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
		const held = await turns.take(() => "not");
		const stop = new AbortController();
		const waited = turns.take(() => "not", stop.signal);
		let next = false;
		void turns
			.take(() => "not")
			.then(() => {
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

	it("says no for a turn a peer agent's or the machine's steer began", () => {
		const peers = steerText(
			{ text: "how far along?", from: "ospht4", file: "f" },
			{ busy: true },
		);
		expect(
			beganWithPersonsWords([user(peers), answer]),
			"a peer asking from outside the window",
		).toBe(false);
	});
});

describe("whether words a session is given are Joel's", () => {
	const steered = (from: string | undefined) =>
		isJoelsWords({
			role: "user",
			content: steerText(
				{ text: "are you back?", from, file: "f" },
				{ busy: true },
			),
		});

	it("counts what he types and what he steers in from outside the window", () => {
		expect(
			isJoelsWords({ role: "user", content: "are you back?" }),
			"typed",
		).toBe(true);
		expect(steered("joel"), "steered by name").toBe(true);
		expect(steered("person"), "steered through the node").toBe(true);
		expect(steered(undefined), "steered naming nobody").toBe(true);
	});

	it("counts no steer a peer agent or the machine wrote, nor the harness's words", () => {
		expect(steered("ospht4"), "a peer agent's").toBe(false);
		expect(steered(FROM_MACHINE), "the machine's").toBe(false);
		expect(
			isJoelsWords({
				role: "user",
				content:
					"[Automated message, no human input: background work is reporting.] done",
			}),
			"the harness's",
		).toBe(false);
	});
});
