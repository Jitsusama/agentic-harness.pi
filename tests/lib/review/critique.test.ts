import { describe, expect, it } from "vitest";
import type {
	AskAnswer,
	CritiqueDeps,
	Participant,
	Roster,
} from "../../../lib/review/index.js";
import { harvestCritiques, runCritique } from "../../../lib/review/index.js";

/** The wire shape a critic answers in. */
const answer = (...critiques: unknown[]) => JSON.stringify({ critiques });

const one = (over: Record<string, unknown> = {}) => ({
	findingId: 1,
	position: "agree",
	rationale: "the handle really is left open",
	...over,
});

const roster: Roster = { reviewers: [{ id: "hawk" }, { id: "owl" }] };

function deps(
	answers: Record<string, AskAnswer>,
	asked: Participant[] = [],
): CritiqueDeps {
	return {
		async ask(participant) {
			asked.push(participant);
			return answers[participant.id] ?? { failure: "nobody scripted this" };
		},
		now: () => new Date("2026-07-30T02:00:00.000Z"),
	};
}

describe("reading one critic's answer", () => {
	it("takes a position on a finding", () => {
		const { critiques, warnings } = harvestCritiques(
			answer(one()),
			"hawk",
			[1],
		);

		expect(warnings).toEqual([]);
		expect(critiques).toEqual([
			{
				findingId: 1,
				participantId: "hawk",
				position: "agree",
				rationale: "the handle really is left open",
			},
		]);
	});

	it("takes every position in the vocabulary", () => {
		for (const position of ["agree", "disagree", "qualify", "unsure"]) {
			const { critiques } = harvestCritiques(
				answer(one({ position })),
				"hawk",
				[1],
			);
			expect(critiques[0]?.position, position).toBe(position);
		}
	});

	it("drops a position outside it rather than guessing", () => {
		const { critiques, warnings } = harvestCritiques(
			answer(one({ position: "hmm" })),
			"hawk",
			[1],
		);

		expect(critiques).toEqual([]);
		expect(warnings[0]).toContain("hmm");
	});

	it("insists on a rationale, since a bare vote persuades nobody", () => {
		// A position with no argument cannot be weighed against the
		// finding it disputes, so it is worth less than silence.
		const { critiques, warnings } = harvestCritiques(
			answer(one({ rationale: "  " })),
			"hawk",
			[1],
		);

		expect(critiques).toEqual([]);
		expect(warnings[0]).toMatch(/rationale/i);
	});

	it("drops a critique of a finding that was never put to it", () => {
		// A critic inventing a finding id would attach an opinion to
		// something else's number, which is worse than losing it.
		const { critiques, warnings } = harvestCritiques(
			answer(one({ findingId: 99 })),
			"hawk",
			[1, 2],
		);

		expect(critiques).toEqual([]);
		expect(warnings[0]).toContain("99");
	});

	it("keeps the good ones when one is malformed", () => {
		const { critiques, warnings } = harvestCritiques(
			answer(one(), { position: "agree" }, one({ findingId: 2 })),
			"hawk",
			[1, 2],
		);

		expect(critiques.map((c) => c.findingId)).toEqual([1, 2]);
		expect(warnings).toHaveLength(1);
	});

	it("takes silence about a finding as no position, not as agreement", () => {
		// Reading an absent critique as assent would manufacture
		// consensus out of a critic that simply ran out of budget.
		const { critiques } = harvestCritiques(answer(one()), "hawk", [1, 2, 3]);

		expect(critiques).toHaveLength(1);
	});

	it("warns when nothing in the answer parsed", () => {
		const { warnings } = harvestCritiques(
			"I disagree with all of it",
			"hawk",
			[1],
		);

		expect(warnings.join(" ")).toMatch(/critiques|json/i);
	});
});

describe("a whole critique round", () => {
	it("asks everybody and gathers what they said", async () => {
		const asked: Participant[] = [];
		const { critiques } = await runCritique(
			{ roster, prompt: "push back", seq: 1, findingIds: [1] },
			deps(
				{
					hawk: { text: answer(one()) },
					owl: { text: answer(one({ position: "disagree" })) },
				},
				asked,
			),
		);

		expect(asked.map((p) => p.id)).toEqual(["hawk", "owl"]);
		expect(critiques.map((c) => [c.participantId, c.position])).toEqual([
			["hawk", "agree"],
			["owl", "disagree"],
		]);
	});

	it("records the round as a critique", async () => {
		const { run } = await runCritique(
			{ roster, prompt: "p", seq: 1, findingIds: [1] },
			deps({ hawk: { text: answer(one()) }, owl: { text: answer(one()) } }),
		);

		expect(run.round).toBe("critique");
		expect(run.id).toMatch(/^critique-/);
	});

	it("raises no findings, because a critique is not a discovery pass", async () => {
		// Positions and findings are different things, and letting a
		// critic add findings would make the round both and neither.
		const { run } = await runCritique(
			{ roster, prompt: "p", seq: 1, findingIds: [1] },
			deps({ hawk: { text: answer(one()) }, owl: { text: answer(one()) } }),
		);

		expect(run.outcomes.every((o) => o.findingIds.length === 0)).toBe(true);
	});

	it("survives a critic that fails", async () => {
		const { run, critiques } = await runCritique(
			{ roster, prompt: "p", seq: 1, findingIds: [1] },
			deps({
				hawk: { text: answer(one()) },
				owl: { failure: "overloaded" },
			}),
		);

		expect(critiques).toHaveLength(1);
		expect(run.outcomes[1]?.failure).toBe("overloaded");
	});

	it("keeps positions in roster order, whoever answered first", async () => {
		const { critiques } = await runCritique(
			{ roster, prompt: "p", seq: 1, findingIds: [1, 2] },
			deps({
				hawk: { text: answer(one({ findingId: 2 })) },
				owl: { text: answer(one({ findingId: 1 })) },
			}),
		);

		expect(critiques.map((c) => c.participantId)).toEqual(["hawk", "owl"]);
	});

	it("says nothing to critique when the judge found nothing", async () => {
		// Asking six models to push back on an empty list is a bill for
		// nothing.
		const { run, critiques } = await runCritique(
			{ roster, prompt: "p", seq: 1, findingIds: [] },
			deps({ hawk: { text: answer() }, owl: { text: answer() } }),
		);

		expect(critiques).toEqual([]);
		expect(run.outcomes).toEqual([]);
		expect(run.participants).toEqual([]);
	});
});
