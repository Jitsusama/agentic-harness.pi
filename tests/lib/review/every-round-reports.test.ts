/**
 * Every round says it is alive, whoever it asks.
 *
 * Reporting was left to each round to remember and the judge did not: it
 * consolidated sixty-one findings showing nothing at all, no participant,
 * no activity, no sign it had started. Driving it is what found that,
 * because every unit test passed and the round returned the right answer.
 *
 * Written as one table over every round rather than a test per round,
 * because the defect is not a property of the judge. Three of six rounds
 * ask a single participant, each was free to spell the beats out for
 * itself, and the next one added would be free to forget them again. A
 * round that reports nothing looks identical to a round that has hung,
 * and the longest rounds are the ones asking one participant to read
 * everything the others said.
 */

import { describe, expect, it } from "vitest";
import type {
	AskProgress,
	AskProgressEntry,
	CouncilDeps,
	Participant,
} from "../../../lib/review/index.js";
import {
	runAudit,
	runCouncil,
	runCritique,
	runJudge,
	trackAskProgress,
} from "../../../lib/review/index.js";

/** A participant, spelled the way a roster carries one. */
const ONE: Participant = { id: "wren", model: "opus" };

/** An answer with one finding in it, in the wire shape a round parses. */
const FINDING = JSON.stringify({
	findings: [
		{
			location: { kind: "file", file: "lib/a.ts" },
			label: "issue",
			subject: "This leaks",
			discussion: "worth saying",
		},
	],
});

/** An answer with one position in it, which is what a critique reads. */
const POSITION = JSON.stringify({
	positions: [{ finding: 1, position: "agree", reasoning: "it does leak" }],
});

/** An answer with one standing in it, which is what an audit reads. */
const STANDING = JSON.stringify({
	audits: [{ thread: 1, standing: "addressed", reasoning: "fixed in place" }],
});

/** Deps that answer with the given text and number what they file. */
function deps(
	text: string,
	progress: AskProgress,
	seen: string[] = [],
): CouncilDeps {
	let issued = 0;
	return {
		async ask(_participant, _prompt, context) {
			seen.push(context.runId);
			// A real runner narrates while it works, and the panel's whole
			// purpose is to show that, so a fake that never narrates would
			// let a round pass this while looking frozen in practice.
			context.report?.("reading lib/a.ts");
			return { text };
		},
		async record(findings) {
			return findings.map((finding) => {
				issued += 1;
				return { ...finding, id: issued };
			});
		},
		now: () => new Date("2026-07-30T01:00:00.000Z"),
		progress,
	};
}

/** Every round, and how to start it. */
const ROUNDS: readonly [
	string,
	(deps: CouncilDeps) => Promise<{ run: { id: string } }>,
][] = [
	[
		"a council",
		(d) =>
			runCouncil({ roster: { reviewers: [ONE] }, prompt: "look", seq: 1 }, d),
	],
	[
		"a judge",
		(d) => runJudge({ judge: ONE, prompt: "consolidate", seq: 1 }, d),
	],
	[
		"a critique",
		(d) =>
			runCritique(
				{
					roster: { reviewers: [ONE] },
					prompt: "push back",
					seq: 1,
					findingIds: [1],
				},
				d,
			),
	],
	[
		"an audit",
		(d) =>
			runAudit(
				{
					auditor: ONE,
					prompt: "judge the threads",
					seq: 1,
					threadIndices: [1],
				},
				d,
			),
	],
];

/** What a round said, in the order it said it. */
function recorder(): { progress: AskProgress; said: string[] } {
	const said: string[] = [];
	const { progress } = trackAskProgress();
	return {
		said,
		progress: {
			start(participants) {
				said.push(`start:${participants.map((one) => one.id).join(",")}`);
				progress.start(participants);
			},
			started(id) {
				said.push(`started:${id}`);
				progress.started(id);
			},
			activity(id, what) {
				said.push(`activity:${id}:${what}`);
				progress.activity(id, what);
			},
			answered(id) {
				said.push(`answered:${id}`);
				progress.answered(id);
			},
			failed(id, reason) {
				said.push(`failed:${id}:${reason}`);
				progress.failed(id, reason);
			},
			cancelled(id) {
				said.push(`cancelled:${id}`);
				progress.cancelled(id);
			},
			recorded(id, findings) {
				said.push(`recorded:${id}:${findings}`);
				progress.recorded(id, findings);
			},
			finish() {
				said.push("finish");
				progress.finish();
			},
		},
	};
}

const ANSWERS: Record<string, string> = {
	"a council": FINDING,
	"a judge": FINDING,
	"a critique": POSITION,
	"an audit": STANDING,
};

describe("a round reports that it is working", () => {
	for (const [what, start] of ROUNDS) {
		it(`${what} names its participant before it asks`, async () => {
			const { progress, said } = recorder();

			await start(deps(ANSWERS[what], progress));

			expect(said).toContain(`start:${ONE.id}`);
			expect(said).toContain(`started:${ONE.id}`);
		});

		it(`${what} passes on what the participant is doing`, async () => {
			// Without this a panel shows a name and a spinner, which is the
			// same thing it shows for a subagent that died quietly.
			const { progress, said } = recorder();

			await start(deps(ANSWERS[what], progress));

			expect(said).toContain(`activity:${ONE.id}:reading lib/a.ts`);
		});

		it(`${what} says the participant answered`, async () => {
			const { progress, said } = recorder();

			await start(deps(ANSWERS[what], progress));

			expect(said).toContain(`answered:${ONE.id}`);
		});

		it(`${what} tells the runner which round it is asking for`, async () => {
			// A reviewer leaves a transcript behind, and a transcript that
			// cannot be traced to the round that paid for it is no better
			// than none: the whole point is answering "what did that cost
			// and what did it find" months later. The runner cannot know
			// the round on its own, so the round has to say.
			const { progress } = recorder();
			const seen: string[] = [];

			const { run } = await start(deps(ANSWERS[what], progress, seen));

			expect(seen).toEqual([run.id]);
		});

		it(`${what} finishes, so nothing is left on screen`, async () => {
			// A board that outlives its round describes something that is
			// no longer happening, and the round's own answer replaces it.
			const { progress, said } = recorder();

			await start(deps(ANSWERS[what], progress));

			expect(said.at(-1)).toBe("finish");
		});
	}

	it("counts a judge's findings from what was filed", async () => {
		// The same rule the roster rounds settle by: a finding that would
		// not parse never became one, so counting the answer would
		// overstate the round in the one place anyone sees it live.
		const { progress, said } = recorder();

		await runJudge(
			{ judge: ONE, prompt: "consolidate", seq: 1 },
			deps(FINDING, progress),
		);

		expect(said).toContain(`recorded:${ONE.id}:1`);
	});

	it("still reports when the participant fails", async () => {
		// The case where somebody is most likely to be watching.
		const { progress, said } = recorder();
		const broken: CouncilDeps = {
			...deps(FINDING, progress),
			async ask() {
				throw new Error("subagent exited 1");
			},
		};

		await runJudge({ judge: ONE, prompt: "consolidate", seq: 1 }, broken);

		// The reason reaches the panel, whatever the frame appended to
		// it: a thrown failure says where it was thrown from as well as
		// what it said.
		expect(
			said.some((one) => one.startsWith(`failed:${ONE.id}:subagent exited 1`)),
		).toBe(true);
		expect(said.at(-1)).toBe("finish");
	});

	it("folds the entries so a panel can draw one row per participant", async () => {
		// The reporter is the thing a panel reads, so the beats have to
		// arrive as state rather than as a log.
		const { progress, entries } = trackAskProgress();

		await runJudge(
			{ judge: ONE, prompt: "consolidate", seq: 1 },
			deps(FINDING, progress),
		);

		const rows: readonly AskProgressEntry[] = entries();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.participantId).toBe(ONE.id);
		expect(rows[0]?.state).toBe("answered");
		expect(rows[0]?.findings).toBe(1);
	});
});
