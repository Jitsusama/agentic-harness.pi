import { describe, expect, it } from "vitest";
import type { AskRun, Participant } from "../../../lib/review/index.js";
import { startCouncil } from "../../../lib/review/index.js";

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
