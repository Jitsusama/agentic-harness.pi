import { describe, expect, it } from "vitest";
import type {
	AskAnswer,
	CritiqueDeps,
	Participant,
} from "../../../lib/review/index.js";
import { harvestAudits, runAudit } from "../../../lib/review/index.js";

const answer = (...audits: unknown[]) => JSON.stringify({ audits });

const one = (over: Record<string, unknown> = {}) => ({
	threadIndex: 1,
	standing: "addressed",
	rationale: "the handle is closed on line 42 now",
	...over,
});

const auditor: Participant = { id: "wren", model: "opus" };

function deps(answers: AskAnswer, asked: Participant[] = []): CritiqueDeps {
	return {
		async ask(participant) {
			asked.push(participant);
			return answers;
		},
		now: () => new Date("2026-07-30T03:00:00.000Z"),
	};
}

describe("reading an audit", () => {
	it("takes a standing on a thread", () => {
		const { audits, warnings } = harvestAudits(answer(one()), "wren", [1]);

		expect(warnings).toEqual([]);
		expect(audits).toEqual([
			{
				threadIndex: 1,
				participantId: "wren",
				standing: "addressed",
				rationale: "the handle is closed on line 42 now",
			},
		]);
	});

	it("takes every standing in the vocabulary", () => {
		for (const standing of [
			"addressed",
			"outstanding",
			"elsewhere",
			"unclear",
		]) {
			const { audits } = harvestAudits(answer(one({ standing })), "wren", [1]);
			expect(audits[0]?.standing, standing).toBe(standing);
		}
	});

	it("keeps evidence when the auditor cites some", () => {
		const { audits } = harvestAudits(
			answer(one({ evidence: "lib/a.ts:42" })),
			"wren",
			[1],
		);

		expect(audits[0]?.evidence).toBe("lib/a.ts:42");
	});

	it("drops a standing outside the vocabulary", () => {
		const { audits, warnings } = harvestAudits(
			answer(one({ standing: "probably" })),
			"wren",
			[1],
		);

		expect(audits).toEqual([]);
		expect(warnings[0]).toContain("probably");
	});

	it("insists on a rationale", () => {
		// An audit exists to inform a reply. A standing with no argument
		// gives the person replying nothing to say.
		const { audits, warnings } = harvestAudits(
			answer(one({ rationale: " " })),
			"wren",
			[1],
		);

		expect(audits).toEqual([]);
		expect(warnings[0]).toMatch(/rationale/i);
	});

	it("drops an audit of a thread that was never put up", () => {
		const { audits, warnings } = harvestAudits(
			answer(one({ threadIndex: 9 })),
			"wren",
			[1, 2],
		);

		expect(audits).toEqual([]);
		expect(warnings[0]).toContain("9");
	});

	it("keeps the good ones when one is malformed", () => {
		const { audits, warnings } = harvestAudits(
			answer(one(), { standing: "addressed" }, one({ threadIndex: 2 })),
			"wren",
			[1, 2],
		);

		expect(audits.map((a) => a.threadIndex)).toEqual([1, 2]);
		expect(warnings).toHaveLength(1);
	});

	it("warns when nothing parsed", () => {
		const { warnings } = harvestAudits("they all look fine to me", "wren", [1]);

		expect(warnings.join(" ")).toMatch(/audits|json/i);
	});
});

describe("a whole audit round", () => {
	it("asks the auditor and gathers what it said", async () => {
		const asked: Participant[] = [];
		const { audits } = await runAudit(
			{ auditor, prompt: "audit these", seq: 1, threadIndices: [1, 2] },
			deps(
				{
					text: answer(one(), one({ threadIndex: 2, standing: "outstanding" })),
				},
				asked,
			),
		);

		expect(asked).toEqual([auditor]);
		expect(audits.map((a) => [a.threadIndex, a.standing])).toEqual([
			[1, "addressed"],
			[2, "outstanding"],
		]);
	});

	it("records the round as an audit", async () => {
		const { run } = await runAudit(
			{ auditor, prompt: "p", seq: 1, threadIndices: [1] },
			deps({ text: answer(one()) }),
		);

		expect(run.round).toBe("audit");
		expect(run.id).toMatch(/^audit-/);
	});

	it("holds the auditor as a judge, since it is weighing not finding", async () => {
		const { run } = await runAudit(
			{ auditor, prompt: "p", seq: 1, threadIndices: [1] },
			deps({ text: answer(one()) }),
		);

		expect(run.participants).toEqual([
			{ id: "wren", role: "judge", model: "opus" },
		]);
	});

	it("raises no findings", async () => {
		// An audit reports on threads other people started. Turning that
		// into findings would put their words in the review as ours.
		const { run } = await runAudit(
			{ auditor, prompt: "p", seq: 1, threadIndices: [1] },
			deps({ text: answer(one()) }),
		);

		expect(run.outcomes[0]?.findingIds).toEqual([]);
	});

	it("survives an auditor that fails", async () => {
		const { run, audits } = await runAudit(
			{ auditor, prompt: "p", seq: 1, threadIndices: [1] },
			deps({ failure: "overloaded" }),
		);

		expect(audits).toEqual([]);
		expect(run.outcomes[0]?.failure).toBe("overloaded");
	});

	it("asks nobody when there are no threads to audit", async () => {
		const asked: Participant[] = [];
		const { run, audits } = await runAudit(
			{ auditor, prompt: "p", seq: 1, threadIndices: [] },
			deps({ text: answer() }, asked),
		);

		expect(asked).toEqual([]);
		expect(audits).toEqual([]);
		expect(run.participants).toEqual([]);
	});
});
