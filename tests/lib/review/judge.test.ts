import { describe, expect, it } from "vitest";
import type {
	AskAnswer,
	AskRun,
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

// What a judge round records about the commit it read lives with the
// other round kinds, in every-round-says-what-it-read.test.ts, since
// the fact worth holding is that they all do it and not that this one
// does.

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

	it("writes the round down before it asks anybody", async () => {
		// A judge is cheaper than the council it consolidates and not
		// cheap, and a session that dies partway through leaves a
		// directory on disk with nothing saying it was ever a round, so
		// the sweep takes the only copy of what was concluded. The
		// callback was on the shared dependency type and honoured by one
		// of the two runners that take it.
		const opened: AskRun[] = [];
		const base = deps({ text: consolidated() });
		// Recorded and asserted afterwards, never inside the callback.
		// `askOne` folds a thrown runner into a reported failure, so an
		// expectation raised in there is swallowed and the case passes
		// however the ordering comes out. The first version of this test
		// did exactly that and could not fail on the thing it is named
		// for.
		const order: string[] = [];

		await runJudge(
			{ judge, prompt: "p", seq: 1, witness: "abc1234" },
			{
				...base,
				async ask(participant, prompt, context) {
					order.push("asked");
					return base.ask(participant, prompt, context);
				},
				async opened(run) {
					order.push("written down");
					opened.push(run);
				},
			},
		);

		expect(order).toEqual(["written down", "asked"]);
		expect(opened).toHaveLength(1);
		expect(opened[0]?.open).toBe(true);
		expect(opened[0]?.round).toBe("judge");
		// The judge as a judge, so a ledger entry for an interrupted
		// round says who was asked rather than merely that somebody was.
		expect(opened[0]?.participants.map((one) => one.role)).toEqual(["judge"]);
		// And what it read, which is the half most worth having on an
		// interrupted round: whoever finds one has nothing else saying
		// which commit it was formed against.
		expect(opened[0]?.witness).toBe("abc1234");
	});

	it("runs even when writing it down throws", async () => {
		// The bookkeeping is worth less than the round. A callback that
		// throws must not take down a consolidation that has a council
		// behind it.
		const { run } = await runJudge(
			{ judge, prompt: "p", seq: 1 },
			{
				...deps({ text: consolidated() }),
				async opened() {
					throw new Error("the ledger is a directory");
				},
			},
		);

		expect(run.round).toBe("judge");
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
			pending: 0,
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
