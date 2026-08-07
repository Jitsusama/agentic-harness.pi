import { describe, expect, it } from "vitest";
import type { AskRun, Participant } from "../../../lib/review/index.js";
import { roundAnswer, startCouncil } from "../../../lib/review/index.js";

/** Two reviewers, which is enough to see whether they overlap. */
const ROSTER = {
	reviewers: [{ id: "hawk" }, { id: "owl" }] as Participant[],
};

const REQUEST = { roster: ROSTER, prompt: "read it", seq: 1 };

/** A clock that does not move, so ids are predictable. */
function at(when = "2026-08-06T00:00:00.000Z") {
	return () => new Date(when);
}

describe("starting a round without waiting for it", () => {
	it("hands back a round that is open and has answered nothing", async () => {
		const { run } = await startCouncil(REQUEST, {
			now: at(),
			async start() {},
		});

		expect(run.open).toBe(true);
		expect(run.outcomes).toEqual([]);
		expect(run.participants.map((p) => p.id)).toEqual(["hawk", "owl"]);
	});

	it("writes the round down before it starts anybody", async () => {
		// The whole point of a detached round is that nothing is
		// waiting for it, so the ledger entry is the only thing that
		// will ever say these reviewers were a round.
		const order: string[] = [];

		await startCouncil(REQUEST, {
			now: at(),
			async opened() {
				order.push("opened");
			},
			async start(participant) {
				order.push(participant.id);
			},
		});

		expect(order).toEqual(["opened", "hawk", "owl"]);
	});

	it("starts every reviewer even when one of them will not start", async () => {
		// A model that cannot be spawned must not cost the other six
		// their round, the same bargain a live council makes.
		const started: string[] = [];

		const { warnings } = await startCouncil(REQUEST, {
			now: at(),
			async start(participant) {
				if (participant.id === "hawk") throw new Error("no such binary");
				started.push(participant.id);
			},
		});

		expect(started).toEqual(["owl"]);
		expect(warnings.join(" ")).toMatch(/hawk.*no such binary/);
	});

	it("records the reviewer that would not start as having failed", async () => {
		// A reviewer that never started is a reviewer that failed, and
		// leaving it silent means the collect that finishes this round
		// has to rediscover from an empty directory something that was
		// known here, with the reason no longer to hand.
		const { run, started } = await startCouncil(REQUEST, {
			now: at(),
			async start(participant) {
				if (participant.id === "hawk") throw new Error("no such binary");
			},
		});

		expect(started).toBe(1);
		expect(run.outcomes).toHaveLength(1);
		expect(run.outcomes[0]?.participantId).toBe("hawk");
		expect(run.outcomes[0]?.failure).toMatch(/no such binary/);
		// And the round stays open for the one that did start.
		expect(run.open).toBe(true);
	});

	it("refuses the round when nobody could be started", async () => {
		// An open round with no reviewer behind it is an alarm that can
		// never be answered: collect would find nothing forever.
		const { run, warnings } = await startCouncil(REQUEST, {
			now: at(),
			async start() {
				throw new Error("no such binary");
			},
		});

		expect(run.open).toBeUndefined();
		expect(warnings.join(" ")).toMatch(/nobody/i);
	});

	it("says how many are running rather than leaving it to arithmetic", async () => {
		// The caller used to subtract the warnings from the roster,
		// which assumes one warning per reviewer. Two of the warnings
		// here are about the round rather than about anybody on it, and
		// a round that started nobody because its ledger write failed
		// reported six of seven running.
		const { started } = await startCouncil(REQUEST, {
			now: at(),
			async opened() {
				throw new Error("the disk is full");
			},
			async start() {
				throw new Error("should never be reached");
			},
		});

		expect(started).toBe(0);
	});

	it("does not accuse reviewers nobody asked anything", async () => {
		// A settled round reads silence as a participant that dropped,
		// so a round handed back with the full roster and no outcomes
		// renders as "0/2 answered, 2 failed" when not one of them was
		// asked. They each get the outcome they actually had, and the
		// reason belongs to the round rather than to any of them, which
		// is what an advisory is: hoisted once, the roll call says so.
		const { run } = await startCouncil(REQUEST, {
			now: at(),
			async opened() {
				throw new Error("the disk is full");
			},
			async start() {
				throw new Error("should never be reached");
			},
		});

		expect(run.outcomes).toHaveLength(REQUEST.roster.reviewers.length);
		for (const outcome of run.outcomes) {
			expect(outcome.failure).toMatch(/could not be written down first/);
			expect(outcome.advisory).toBe(outcome.failure);
		}
		expect(roundAnswer(run).filter((line) => line.mark === "refused")).toEqual([
			{ mark: "refused", text: run.outcomes[0]?.advisory },
		]);
	});

	it("remembers the witness a later collect will anchor against", async () => {
		const seen: AskRun[] = [];

		const { run } = await startCouncil(
			{ ...REQUEST, witness: "abc1234" },
			{
				now: at(),
				async opened(opened) {
					seen.push(opened);
				},
				async start() {},
			},
		);

		expect(run.witness).toBe("abc1234");
		expect(seen[0]?.witness).toBe("abc1234");
	});
});
