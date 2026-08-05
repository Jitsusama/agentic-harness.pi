import { describe, expect, it } from "vitest";
import type {
	AskAnswer,
	CouncilDeps,
	Finding,
	Participant,
	Roster,
} from "../../../lib/review/index.js";
import { runCouncil, runSummary } from "../../../lib/review/index.js";

/** A reviewer answer carrying one finding about a file. */
function said(subject: string, file = "lib/a.ts"): string {
	return JSON.stringify({
		findings: [
			{
				location: { kind: "file", file },
				label: "issue",
				subject,
				discussion: "because",
			},
		],
	});
}

const roster: Roster = {
	reviewers: [{ id: "hawk" }, { id: "owl" }],
};

/**
 * Deps over a script of answers, recording findings into a list and
 * numbering them the way the real store does.
 */
function deps(
	answers: Record<string, AskAnswer | (() => Promise<AskAnswer>)>,
	options: { readonly recorded?: Finding[]; readonly asked?: string[] } = {},
): CouncilDeps {
	const recorded = options.recorded ?? [];
	const asked = options.asked ?? [];
	let issued = 0;
	return {
		async ask(participant: Participant) {
			asked.push(participant.id);
			const scripted = answers[participant.id];
			if (scripted === undefined) return { failure: "nobody scripted this" };
			return typeof scripted === "function" ? scripted() : scripted;
		},
		async record(findings) {
			// Deliberately yields before numbering, and yields longer
			// for hawk than for owl. A real store writes to disk, so
			// numbering is not instantaneous, and a fake that numbers
			// synchronously cannot tell ordered recording from
			// concurrent recording: found by a surviving mutant that
			// swapped the sequential loop for a Promise.all and broke
			// nothing. With this delay, concurrent recording gives owl
			// the lower number and the ordering tests fail.
			const origin = findings[0]?.origin;
			const slow =
				origin !== undefined &&
				origin.kind !== "hand" &&
				origin.reviewerId === "hawk";
			await new Promise((r) => setTimeout(r, slow ? 20 : 0));
			const numbered = findings.map((f) => {
				issued += 1;
				return { ...f, id: issued };
			});
			recorded.push(...numbered);
			return numbered;
		},
		now: () => new Date("2026-07-30T00:00:00.000Z"),
	};
}

describe("fanning a roster out", () => {
	it("asks everybody on it", async () => {
		const asked: string[] = [];
		await runCouncil(
			{ roster, prompt: "review this", seq: 1 },
			deps({ hawk: { text: said("a") }, owl: { text: said("b") } }, { asked }),
		);

		expect(asked.sort()).toEqual(["hawk", "owl"]);
	});

	it("records what each of them raised", async () => {
		const recorded: Finding[] = [];
		await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps(
				{ hawk: { text: said("from hawk") }, owl: { text: said("from owl") } },
				{ recorded },
			),
		);

		expect(recorded.map((f) => f.subject)).toEqual(["from hawk", "from owl"]);
	});

	it("numbers findings in roster order, not answering order", async () => {
		// People say finding numbers out loud, so which number a finding
		// gets must not depend on which model happened to be quickest.
		const recorded: Finding[] = [];
		await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps(
				{
					// hawk is slow, owl is instant: without ordered recording
					// owl's finding would be numbered first.
					hawk: async () => {
						await new Promise((r) => setTimeout(r, 20));
						return { text: said("from hawk") };
					},
					owl: { text: said("from owl") },
				},
				{ recorded },
			),
		);

		expect(recorded.map((f) => [f.id, f.subject])).toEqual([
			[1, "from hawk"],
			[2, "from owl"],
		]);
	});

	it("attributes each finding to the participant that raised it", async () => {
		const recorded: Finding[] = [];
		await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps(
				{ hawk: { text: said("a") }, owl: { text: said("b") } },
				{ recorded },
			),
		);

		expect(recorded.map((f) => f.origin)).toEqual([
			{ kind: "reviewer", runId: expect.any(String), reviewerId: "hawk" },
			{ kind: "reviewer", runId: expect.any(String), reviewerId: "owl" },
		]);
	});

	it("points every finding at the run that produced it", async () => {
		const recorded: Finding[] = [];
		const { run } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps({ hawk: { text: said("a") } }, { recorded }),
		);

		for (const finding of recorded) {
			expect(finding.origin).toMatchObject({ runId: run.id });
		}
	});
});

describe("the run it records", () => {
	it("holds who was asked, as reviewers", async () => {
		const { run } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps({ hawk: { text: said("a") }, owl: { text: said("b") } }),
		);

		expect(run.participants).toEqual([
			{ id: "hawk", role: "reviewer" },
			{ id: "owl", role: "reviewer" },
		]);
	});

	it("holds each participant's finding ids", async () => {
		const { run } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps({ hawk: { text: said("a") }, owl: { text: said("b") } }),
		);

		expect(run.outcomes).toEqual([
			{ participantId: "hawk", findingIds: [1] },
			{ participantId: "owl", findingIds: [2] },
		]);
	});

	it("is a council run by default", async () => {
		const { run } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps({ hawk: { text: said("a") } }),
		);

		expect(run.round).toBe("council");
		expect(run.id).toMatch(/^council-/);
	});

	it("carries usage where the runner reported it", async () => {
		const { run } = await runCouncil(
			{ roster: { reviewers: [{ id: "hawk" }] }, prompt: "p", seq: 1 },
			deps({ hawk: { text: said("a"), usage: { tokens: 10, cost: 0.02 } } }),
		);

		expect(run.outcomes[0]?.usage).toEqual({ tokens: 10, cost: 0.02 });
	});
});

describe("when a participant fails", () => {
	it("keeps the others and records the failure", async () => {
		// One model being unavailable must not lose the work of the rest.
		const { run } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps({ hawk: { text: said("a") }, owl: { failure: "overloaded" } }),
		);

		expect(runSummary(run)).toEqual({
			asked: 2,
			answered: 1,
			failed: 1,
			findings: 1,
		});
		expect(run.outcomes[1]).toMatchObject({ failure: "overloaded" });
	});

	it("survives one that throws rather than answering", async () => {
		// A runner that rejects is the same event as one that reports a
		// failure, and neither may take the council down.
		const { run } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps({
				hawk: { text: said("a") },
				owl: () => Promise.reject(new Error("socket hung up")),
			}),
		);

		expect(run.outcomes[1]?.failure).toContain("socket hung up");
		expect(runSummary(run).answered).toBe(1);
	});

	it("still numbers the survivors in roster order", async () => {
		const recorded: Finding[] = [];
		await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps(
				{ hawk: { failure: "gone" }, owl: { text: said("from owl") } },
				{ recorded },
			),
		);

		expect(recorded.map((f) => [f.id, f.subject])).toEqual([[1, "from owl"]]);
	});
});

describe("when a participant is stopped at a limit", () => {
	it("records the stop rather than treating the corpse as an answer", async () => {
		// A reviewer killed between tool calls has just said something
		// conversational. Harvesting that and reporting unparseable JSON
		// blames the reviewer for our own deadline, and sent a real user
		// into three identical retries that could never have worked.
		const { run } = await runCouncil(
			{ roster: { reviewers: [{ id: "hawk" }] }, prompt: "p", seq: 1 },
			deps({
				hawk: {
					text: "Let me check what the tests around this assume.",
					stopped: {
						limit: "wall-clock",
						detail: "Ran past its 900000ms budget; sent SIGTERM.",
					},
				},
			}),
		);

		expect(run.outcomes[0]?.stopped).toEqual({
			limit: "wall-clock",
			detail: "Ran past its 900000ms budget; sent SIGTERM.",
		});
	});

	it("warns about the limit it hit, not about its JSON", async () => {
		const { warnings } = await runCouncil(
			{ roster: { reviewers: [{ id: "hawk" }] }, prompt: "p", seq: 1 },
			deps({
				hawk: {
					text: "Let me check what the tests around this assume.",
					stopped: {
						limit: "wall-clock",
						detail: "Ran past its 900000ms budget; sent SIGTERM.",
					},
				},
			}),
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("hawk");
		expect(warnings[0]).toContain("900000ms");
		expect(warnings[0]).not.toContain("JSON");
	});

	it("records where the answer was kept, so it can be read back", async () => {
		// The whole reason a round is expensive to lose is that nothing
		// kept what was said. A path on the outcome is what turns "what
		// did that reviewer find" from a re-run into a file read.
		const { run } = await runCouncil(
			{ roster: { reviewers: [{ id: "hawk" }] }, prompt: "p", seq: 1 },
			deps({
				hawk: {
					text: "Let me check what the tests around this assume.",
					answerPath: "/state/answers/council-1/hawk.txt",
					stopped: { limit: "wall-clock", detail: "past its budget" },
				},
			}),
		);

		expect(run.outcomes[0]?.answerPath).toBe(
			"/state/answers/council-1/hawk.txt",
		);
	});

	it("keeps what a stopped reviewer did manage to say", async () => {
		// Being stopped after saying something useful is the common case
		// once findings arrive incrementally, and what it found must not
		// be discarded just because the run did not end cleanly.
		const { run } = await runCouncil(
			{ roster: { reviewers: [{ id: "hawk" }] }, prompt: "p", seq: 1 },
			deps({
				hawk: {
					text: said("found before the wall"),
					stopped: { limit: "output", detail: "exceeded output limits" },
				},
			}),
		);

		expect(run.outcomes[0]?.findingIds).toHaveLength(1);
		expect(run.outcomes[0]?.stopped?.limit).toBe("output");
	});
});

describe("what it warns about", () => {
	it("passes a harvest warning through, saying who it was about", async () => {
		const { warnings } = await runCouncil(
			{ roster: { reviewers: [{ id: "hawk" }] }, prompt: "p", seq: 1 },
			deps({ hawk: { text: "I have opinions but no JSON." } }),
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("hawk");
	});

	it("says nothing when everybody answered cleanly", async () => {
		const { warnings } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps({ hawk: { text: said("a") }, owl: { text: said("b") } }),
		);

		expect(warnings).toEqual([]);
	});

	it("does not warn about a reviewer that simply had nothing to say", async () => {
		const { warnings, run } = await runCouncil(
			{ roster: { reviewers: [{ id: "hawk" }] }, prompt: "p", seq: 1 },
			deps({ hawk: { text: JSON.stringify({ findings: [] }) } }),
		);

		expect(warnings).toEqual([]);
		expect(runSummary(run)).toMatchObject({ answered: 1, findings: 0 });
	});
});
