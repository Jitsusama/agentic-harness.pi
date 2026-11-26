/**
 * Questions still waiting on an answer: asked again of the peer that
 * owes one, and said to be stuck to the peer that asked.
 */
import { describe, expect, it } from "vitest";
import type { Message } from "../../../lib/mesh/message.ts";
import {
	ASK_AGAIN_MS,
	createAwaiting,
	createOwing,
	MOST_ASKED_AGAIN,
	OWED_FOR_MS,
} from "../../../lib/mesh/owed.ts";

const asked = Date.parse("2026-10-25T23:37:00.000Z");

function question(over: Partial<Message> = {}): Message {
	return {
		v: 1,
		id: "1-20KSI7-1-aaaa",
		at: new Date(asked).toISOString(),
		from: "20KSI7",
		to: ["@P9R1KI"],
		text: "is equilibrius ready again?",
		intent: "question",
		pid: 1,
		...over,
	};
}

describe("answers owed", () => {
	it("asks again once the question has waited, and no sooner", () => {
		const owing = createOwing();
		owing.owe(question(), asked);

		expect(owing.due(asked + ASK_AGAIN_MS - 1)).toEqual([]);
		expect(owing.due(asked + ASK_AGAIN_MS)).toEqual([
			{ message: question(), handed: 1 },
		]);
		expect(owing.due(asked + ASK_AGAIN_MS + 1)).toEqual([]);
	});

	it("stops asking once answered", () => {
		const owing = createOwing();
		owing.owe(question(), asked);
		owing.paid(question().id);
		expect(owing.due(asked + ASK_AGAIN_MS)).toEqual([]);
	});

	it("owes nothing for a question handed over again after its answer", () => {
		// A question that waited through a stalled run rides into a later
		// turn too, after the peer has answered it.
		const owing = createOwing();
		owing.owe(question(), asked);
		owing.paid(question().id, asked + 1000);
		owing.owe(question(), asked + 2000);

		expect(owing.due(asked + 2000 + ASK_AGAIN_MS)).toEqual([]);
	});

	it("asks again only so often, and only within the hour", () => {
		const owing = createOwing();
		owing.owe(question(), asked);
		const times = Array.from(
			{ length: MOST_ASKED_AGAIN + 2 },
			(_, one) => owing.due(asked + (one + 1) * ASK_AGAIN_MS).length,
		);
		expect(times.reduce((sum, one) => sum + one, 0)).toBe(MOST_ASKED_AGAIN);

		const late = createOwing();
		late.owe(question(), asked + OWED_FOR_MS);
		expect(late.due(asked + OWED_FOR_MS + ASK_AGAIN_MS)).toEqual([]);
	});

	it("owes nothing for a question its asker withdrew, even handed over again", () => {
		const owing = createOwing();
		owing.owe(question(), asked);
		owing.withdrawn(question().id, asked + 1000);
		owing.owe(question(), asked + 2000);

		expect(owing.due(asked + 2000 + ASK_AGAIN_MS)).toEqual([]);
	});

	it("counts from when it was last handed over", () => {
		const owing = createOwing();
		owing.owe(question(), asked);
		owing.owe(question(), asked + 60_000);
		expect(owing.due(asked + ASK_AGAIN_MS)).toEqual([]);
		expect(owing.due(asked + 60_000 + ASK_AGAIN_MS)).toHaveLength(1);
	});
});

describe("answers awaited", () => {
	it("says a question is stuck, once, with whoever has not answered", () => {
		const awaiting = createAwaiting();
		const both = question({ from: "P9R1KI", to: ["@Y2YBTS", "@85PKB2"] });
		awaiting.asked(both, ["P9R1KI", "WCJQSG"], asked);
		awaiting.answered(both.id, () => ["85PKB2", "EB40158D"]);

		expect(awaiting.stuck(asked + ASK_AGAIN_MS - 1)).toEqual([]);
		expect(awaiting.stuck(asked + ASK_AGAIN_MS)).toEqual([
			{ message: both, waitingOn: ["Y2YBTS"] },
		]);
		expect(awaiting.stuck(asked + 2 * ASK_AGAIN_MS)).toEqual([]);
	});

	it("awaits nothing once every address has answered, or none was named", () => {
		const awaiting = createAwaiting();
		const one = question();
		awaiting.asked(one, ["20KSI7"], asked);
		awaiting.answered(one.id, () => ["WCJQSG", "P9R1KI"]);
		awaiting.asked(question({ id: "2", to: ["#quest/wcjqsg"] }), [], asked);
		awaiting.asked(question({ id: "3", to: ["@20KSI7"] }), ["20KSI7"], asked);
		awaiting.asked(
			question({ id: "4", intent: "fyi", to: ["@P9R1KI"] }),
			[],
			asked,
		);
		expect(awaiting.stuck(asked + ASK_AGAIN_MS)).toEqual([]);
	});

	// On 24 November a withdrawn need was still said to be stuck, and put
	// to the cell it had been sent to in error.
	it("awaits nothing for a question this peer withdrew", () => {
		const awaiting = createAwaiting();
		const one = question({ from: "FZ9MFJ", to: ["@ZYT5ZL"] });
		const other = question({ id: "2", from: "FZ9MFJ", to: ["@SS241B"] });
		awaiting.asked(one, ["FZ9MFJ"], asked);
		awaiting.asked(other, ["FZ9MFJ"], asked);
		awaiting.asked(
			question({
				id: "3",
				from: "FZ9MFJ",
				to: ["@ZYT5ZL"],
				intent: "fyi",
				supersedes: one.id,
			}),
			["FZ9MFJ"],
			asked + 1000,
		);

		expect(awaiting.stuck(asked + ASK_AGAIN_MS)).toEqual([
			{ message: other, waitingOn: ["SS241B"] },
		]);
	});

	it("looks up who answered only for a question it awaits", () => {
		// Every peer sees every answer, and looking one up reads every presence.
		const awaiting = createAwaiting();
		let lookups = 0;
		const from = () => {
			lookups += 1;
			return ["P9R1KI"];
		};
		awaiting.answered("someone else's question", from);
		expect(lookups, "looked up an answer to another peer").toBe(0);

		awaiting.asked(question(), ["20KSI7"], asked);
		awaiting.answered(question().id, from);
		expect(lookups, "didn't look up an answer it awaited").toBe(1);
	});
});

// On 26 November Y2YBTS's "#6682 landed, #6678 can rebase" reached H2VYOB
// as an fyi with no re, and sat unread about six hours.
describe("answers that name no question", () => {
	it("settle the newest question waiting on their sender, once", () => {
		const awaiting = createAwaiting();
		const older = question({ id: "1", to: ["@Y2YBTS"] });
		const newer = question({ id: "2", to: ["@Y2YBTS", "@KP0L6A"] });
		awaiting.asked(older, ["20KSI7"], asked);
		awaiting.asked(newer, ["20KSI7"], asked + 1000);

		expect(awaiting.settledBy("Y2YBTS", () => [], asked + 2000)).toBe(newer);
		expect(awaiting.settledBy("Y2YBTS", () => [], asked + 3000)).toBe(older);
		expect(
			awaiting.settledBy("Y2YBTS", () => [], asked + 4000),
			"a third word settled a question already settled",
		).toBeUndefined();
		expect(awaiting.stuck(asked + 1000 + ASK_AGAIN_MS)).toEqual([
			{ message: newer, waitingOn: ["KP0L6A"] },
		]);
	});

	it("settle one for a sender under another of its addresses", () => {
		const awaiting = createAwaiting();
		const one = question({ to: ["@5DF5FBE4"] });
		awaiting.asked(one, ["20KSI7"], asked);

		expect(
			awaiting.settledBy("Y2YBTS", () => ["Y2YBTS", "5DF5FBE4"], asked),
		).toBe(one);
	});

	it("settle nothing for a peer no question waits on", () => {
		const awaiting = createAwaiting();
		let lookups = 0;
		const aliases = () => {
			lookups += 1;
			return [];
		};
		expect(awaiting.settledBy("Y2YBTS", aliases, asked)).toBeUndefined();
		expect(lookups, "looked a sender up with nothing awaited").toBe(0);

		awaiting.asked(question({ to: ["@KP0L6A"] }), ["20KSI7"], asked);
		expect(awaiting.settledBy("Y2YBTS", aliases, asked)).toBeUndefined();
	});

	it("still settle a question already said to be stuck, within its hour", () => {
		const awaiting = createAwaiting();
		const one = question({ to: ["@Y2YBTS"] });
		awaiting.asked(one, ["20KSI7"], asked);
		expect(awaiting.stuck(asked + ASK_AGAIN_MS)).toHaveLength(1);

		expect(awaiting.settledBy("Y2YBTS", () => [], asked + OWED_FOR_MS)).toBe(
			one,
		);
	});

	it("settle nothing past the hour a question is owed", () => {
		const awaiting = createAwaiting();
		awaiting.asked(question({ to: ["@Y2YBTS"] }), ["20KSI7"], asked);

		expect(
			awaiting.settledBy("Y2YBTS", () => [], asked + OWED_FOR_MS + 1),
		).toBeUndefined();
	});
});
