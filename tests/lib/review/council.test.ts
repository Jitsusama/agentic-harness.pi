import { describe, expect, it } from "vitest";
import type {
	AskAnswer,
	AskRun,
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

describe("a round on the ledger before it costs anything", () => {
	// A council was written down only once it finished, so a session
	// that died mid-round left no record that it had ever run: not the
	// participants, not the round, not the change. The most expensive
	// thing here was the only thing nothing wrote down until it was
	// over.
	it("opens the round before it asks anybody", async () => {
		const order: string[] = [];
		const opened: AskRun[] = [];
		const asked: string[] = [];
		const base = deps(
			{ hawk: { text: said("a") }, owl: { text: said("b") } },
			{ asked },
		);

		await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			{
				...base,
				async ask(participant, prompt, context) {
					order.push(`ask:${participant.id}`);
					return await base.ask(participant, prompt, context);
				},
				async opened(run) {
					order.push("opened");
					opened.push(run);
				},
			},
		);

		expect(order[0]).toBe("opened");
		expect(opened).toHaveLength(1);
		// Enough to find the work again: which round, which id the
		// artifacts on disk are filed under, and who was asked.
		expect(opened[0].round).toBe("council");
		expect(opened[0].id).toMatch(/^council-/);
		expect(opened[0].participants.map((one) => one.id).sort()).toEqual([
			"hawk",
			"owl",
		]);
		// Nothing has answered yet, and the record must not pretend
		// otherwise.
		expect(opened[0].outcomes).toEqual([]);
		expect(opened[0].open).toBe(true);
	});

	it("settles it by dropping the mark once it is over", async () => {
		const { run } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps({ hawk: { text: said("a") }, owl: { text: said("b") } }),
		);

		// Marked while unfinished rather than inferred from a missing
		// finish time. Absence is what every round recorded before this
		// existed already has, and what every judge, critique, audit
		// and stack round will always have, so an alarm keyed on it
		// would call the whole history abandoned.
		expect(run.open).toBeUndefined();
		expect("open" in run).toBe(false);
	});

	it("remembers the witness it was asked against", async () => {
		// An interrupted round is collected from disk later, and a
		// finding harvested then must anchor exactly as it would have
		// live. The witness is the only part of that which is not
		// recoverable from the reviewer's own answer, so a round that
		// does not write it down cannot be collected faithfully.
		const opened: AskRun[] = [];
		const { run } = await runCouncil(
			{ roster, prompt: "p", seq: 1, witness: "abc1234" },
			{
				...deps({ hawk: { text: said("a") }, owl: { text: said("b") } }),
				async opened(run) {
					opened.push(run);
				},
			},
		);

		expect(opened[0]?.witness).toBe("abc1234");
		// And it survives settling, or collecting a round that did
		// finish would anchor differently from the round itself.
		expect(run.witness).toBe("abc1234");
	});

	it("runs the round when opening it throws", async () => {
		// The callback's own docstring promises a round is worth more
		// than the bookkeeping around it. Awaited bare, that promise
		// lived in whoever implemented it, and this seam is public.
		const { run } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			{
				...deps({ hawk: { text: said("a") }, owl: { text: said("b") } }),
				async opened() {
					throw new Error("the ledger is on a read-only volume");
				},
			},
		);

		expect(run.outcomes).toHaveLength(2);
	});

	it("runs the round even when nothing is listening for it", async () => {
		// Every existing caller passes no `opened`, and a round is worth
		// more than the bookkeeping around it.
		const { run } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps({ hawk: { text: said("a") }, owl: { text: said("b") } }),
		);

		expect(run.outcomes).toHaveLength(2);
	});
});

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

/** One finding in the shape a reviewer records as it goes. */
function entry(subject: string, file = "lib/a.ts") {
	return {
		location: { kind: "file", file },
		label: "issue",
		subject,
		discussion: "because",
	};
}

describe("what a reviewer wrote down as it went", () => {
	// Everything before this made an interruption survivable: the answer
	// is kept, whole entries are salvaged from a cut-off one, and a
	// stopped reviewer is asked for what it had. All of it recovers an
	// answer that arrives at the end. A finding recorded when it was
	// found does not need recovering, which is the difference between
	// surviving the class and removing it.
	const one = { reviewers: [{ id: "hawk" }] };

	it("is kept when the answer it was cut off in held nothing", async () => {
		const recorded: Finding[] = [];
		await runCouncil(
			{ roster: one, prompt: "p", seq: 1 },
			deps(
				{
					hawk: {
						text: 'I was partway through checking the error paths when {"fin',
						recorded: [entry("the retry loop never backs off")],
						stopped: { limit: "wall-clock", detail: "ran out of time" },
					},
				},
				{ recorded },
			),
		);

		expect(recorded.map((f) => f.subject)).toEqual([
			"the retry loop never backs off",
		]);
	});

	it("is not counted twice when the answer says it again", async () => {
		// A reviewer that records as it goes and then writes its full
		// answer has said the same thing twice, which is what the
		// contract asks of it. Reporting both would inflate every round
		// and make the judge consolidate a finding against itself.
		const recorded: Finding[] = [];
		await runCouncil(
			{ roster: one, prompt: "p", seq: 1 },
			deps(
				{
					hawk: {
						text: JSON.stringify({ findings: [entry("the same one")] }),
						recorded: [entry("the same one")],
					},
				},
				{ recorded },
			),
		);

		expect(recorded.map((f) => f.subject)).toEqual(["the same one"]);
	});

	it("keeps the answer's telling of a finding said twice", async () => {
		// Not the longer of the two: the answer's, because it is written
		// after the investigation rather than during it. Usually that is
		// also the fuller one, and where it is not, the reviewer
		// shortened it on purpose.
		const recorded: Finding[] = [];
		await runCouncil(
			{ roster: one, prompt: "p", seq: 1 },
			deps(
				{
					hawk: {
						text: JSON.stringify({
							findings: [
								{
									...entry("the same one"),
									discussion: "because, and here is the whole argument",
								},
							],
						}),
						recorded: [entry("the same one")],
					},
				},
				{ recorded },
			),
		);

		expect(recorded).toHaveLength(1);
		expect(recorded[0].discussion).toBe(
			"because, and here is the whole argument",
		);
	});

	it("treats a refined location as the same finding, not a second one", async () => {
		// A reviewer records against a file and then pins the line in
		// its answer. That is one finding getting sharper, and an
		// anchor-identical comparison would report it twice.
		const recorded: Finding[] = [];
		await runCouncil(
			{ roster: one, prompt: "p", seq: 1 },
			deps(
				{
					hawk: {
						text: JSON.stringify({
							findings: [
								{
									location: { kind: "line", file: "lib/a.ts", line: 42 },
									label: "issue",
									subject: "the retry loop never backs off",
									discussion: "because",
								},
							],
						}),
						recorded: [entry("the retry loop never backs off")],
					},
				},
				{ recorded },
			),
		);

		expect(recorded).toHaveLength(1);
	});

	it("still says what it could not read, even about a reviewer we stopped", async () => {
		// A stopped reviewer's harvest warnings are replaced, so as not
		// to blame it for a sentence our deadline cut in half. A
		// recorded entry is not that: it is a whole line written
		// deliberately, minutes earlier, and it failed on its own
		// merits. Dropping that warning is the silent drop the harvest
		// rules exist to prevent.
		const { warnings } = await runCouncil(
			{ roster: one, prompt: "p", seq: 1 },
			deps({
				hawk: {
					text: "",
					recorded: [{ subject: "no label anywhere" }],
					stopped: { limit: "wall-clock", detail: "ran out of time" },
				},
			}),
		);

		expect(warnings.join(" ")).toMatch(/recorded\[0\]/);
	});

	it("does not call a run that recorded findings a reviewer that said nothing", async () => {
		const { warnings } = await runCouncil(
			{ roster: one, prompt: "p", seq: 1 },
			deps({
				hawk: {
					text: "",
					recorded: [entry("found before the lights went out")],
				},
			}),
		);

		expect(warnings).toEqual([]);
	});

	it("tells them apart when the same words are about different places", async () => {
		const recorded: Finding[] = [];
		await runCouncil(
			{ roster: one, prompt: "p", seq: 1 },
			deps(
				{
					hawk: {
						text: JSON.stringify({
							findings: [entry("unchecked error", "lib/b.ts")],
						}),
						recorded: [entry("unchecked error", "lib/a.ts")],
					},
				},
				{ recorded },
			),
		);

		expect(recorded).toHaveLength(2);
	});
});
