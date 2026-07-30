import { describe, expect, it } from "vitest";
import type {
	AskAnswer,
	CouncilDeps,
	Finding,
	Participant,
} from "../../../lib/review/index.js";
import { runJudge, runSummary } from "../../../lib/review/index.js";

/** A judge answer carrying one consolidated finding. */
function consolidated(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		findings: [
			{
				location: { kind: "file", file: "lib/a.ts" },
				label: "issue",
				subject: "This leaks",
				discussion: "two reviewers found it",
				...over,
			},
		],
	});
}

function deps(
	answer: AskAnswer,
	options: {
		readonly recorded?: Finding[];
		readonly asked?: Participant[];
	} = {},
): CouncilDeps {
	const recorded = options.recorded ?? [];
	const asked = options.asked ?? [];
	let issued = 0;
	return {
		async ask(participant) {
			asked.push(participant);
			return answer;
		},
		async record(findings) {
			const numbered = findings.map((f) => {
				issued += 1;
				return { ...f, id: issued };
			});
			recorded.push(...numbered);
			return numbered;
		},
		now: () => new Date("2026-07-30T01:00:00.000Z"),
	};
}

const judge: Participant = { id: "wren", model: "opus" };

describe("asking a judge", () => {
	it("asks the judge and nobody else", async () => {
		const asked: Participant[] = [];
		await runJudge(
			{ judge, prompt: "consolidate", seq: 1 },
			deps({ text: consolidated() }, { asked }),
		);

		expect(asked).toEqual([judge]);
	});

	it("records the run as a judge round", async () => {
		const { run } = await runJudge(
			{ judge, prompt: "p", seq: 1 },
			deps({ text: consolidated() }),
		);

		expect(run.round).toBe("judge");
		expect(run.id).toMatch(/^judge-/);
	});

	it("holds the judge as a judge, not a reviewer", async () => {
		// The role is what tells a later reader that this participant
		// consolidated rather than discovered, and the identity ledger
		// refuses to let one id be both.
		const { run } = await runJudge(
			{ judge, prompt: "p", seq: 1 },
			deps({ text: consolidated() }),
		);

		expect(run.participants).toEqual([
			{ id: "wren", role: "judge", model: "opus" },
		]);
	});

	it("attributes the consolidated findings to the judge", async () => {
		const recorded: Finding[] = [];
		await runJudge(
			{ judge, prompt: "p", seq: 1 },
			deps({ text: consolidated() }, { recorded }),
		);

		expect(recorded[0]?.origin).toEqual({
			kind: "judge",
			runId: expect.stringMatching(/^judge-/),
			reviewerId: "wren",
		});
	});

	it("survives a judge that fails", async () => {
		const { run } = await runJudge(
			{ judge, prompt: "p", seq: 1 },
			deps({ failure: "overloaded" }),
		);

		expect(runSummary(run)).toEqual({
			asked: 1,
			answered: 0,
			failed: 1,
			findings: 0,
		});
	});

	it("warns about an unreadable answer, naming the judge", async () => {
		const { warnings } = await runJudge(
			{ judge, prompt: "p", seq: 1 },
			deps({ text: "I have thoughts." }),
		);

		expect(warnings[0]).toContain("wren");
	});
});

describe("keeping the agreement", () => {
	it("records which reviewers raised the same thing", async () => {
		// Agreement between independent reviewers is evidence, and the
		// judge is the only pass that knows about it. Dropping it would
		// throw away the reason a finding is more likely to be real.
		const recorded: Finding[] = [];
		await runJudge(
			{ judge, prompt: "p", seq: 1 },
			deps({ text: consolidated({ raisedBy: ["hawk", "owl"] }) }, { recorded }),
		);

		expect(recorded[0]?.raisedBy).toEqual(["hawk", "owl"]);
	});

	it("leaves raisedBy off a finding the judge raised alone", async () => {
		const recorded: Finding[] = [];
		await runJudge(
			{ judge, prompt: "p", seq: 1 },
			deps({ text: consolidated() }, { recorded }),
		);

		expect(recorded[0]?.raisedBy).toBeUndefined();
	});

	it("ignores a raisedBy that is not a list of names", async () => {
		const recorded: Finding[] = [];
		const { warnings } = await runJudge(
			{ judge, prompt: "p", seq: 1 },
			deps({ text: consolidated({ raisedBy: "hawk" }) }, { recorded }),
		);

		expect(recorded[0]?.raisedBy).toBeUndefined();
		expect(warnings).toHaveLength(1);
	});

	it("drops blank names out of raisedBy rather than holding them", async () => {
		const recorded: Finding[] = [];
		await runJudge(
			{ judge, prompt: "p", seq: 1 },
			deps(
				{ text: consolidated({ raisedBy: ["hawk", "  ", ""] }) },
				{ recorded },
			),
		);

		expect(recorded[0]?.raisedBy).toEqual(["hawk"]);
	});
});
