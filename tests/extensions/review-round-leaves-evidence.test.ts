/**
 * A round that spends money and goes wrong still leaves evidence.
 *
 * This is the invariant the whole repair exists to establish, so it is
 * asserted as a property of a round rather than as a fact about any one
 * of the pieces. The pieces all had tests. The round still lost $92.92
 * across two days, because nothing asserted what happened when every
 * piece behaved and the reviewers were stopped anyway.
 *
 * The scenario is the worst real one: council-20260805T181723289, where
 * all seven reviewers ran to the wall clock, none produced parseable
 * output, and the round reported "7/7 answered, 0 findings" having spent
 * 64.4M tokens and $50.63. Afterwards there was nothing on disk to read,
 * so the only diagnostic available was to run it again.
 *
 * What is asserted is deliberately not "the round succeeds". A round can
 * fail. What it may not do is fail without saying why, and without
 * keeping what was paid for.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	answerFromReviewer,
	keepAnswer,
} from "../../extensions/review-integration/reviewer.js";
import type {
	AskAnswer,
	CouncilDeps,
	Finding,
	Roster,
} from "../../lib/review/index.js";
import {
	roundAnswer,
	runCouncil,
	runSummary,
	staleRuntimeAdvisory,
} from "../../lib/review/index.js";
import type { RunReviewerResult } from "../../lib/subagent/index.js";

/** The seven that were asked, named as that round named them. */
const SEVEN = [
	"gitstream-code",
	"gitstream-test",
	"gitstream-failure",
	"clean-design",
	"gitstream-security",
	"gitstream-intent",
	"gitstream-performance",
];

const roster: Roster = { reviewers: SEVEN.map((id) => ({ id })) };

/**
 * What the runner hands back for a reviewer killed at the wall clock.
 *
 * The text is the shape that caused the original misdiagnosis: the
 * conversational line a reviewer says between tool calls, which is not
 * JSON and was never meant to be read as an answer.
 */
function stoppedAtTheWall(id: string): RunReviewerResult {
	return {
		reviewerId: id,
		exitCode: 124,
		finalAssistantText: `Let me check what ${id} needs from the tests.`,
		stderr: "",
		state: "timeout",
		warnings: ["Pi subprocess timed out after 2700000ms; sent SIGTERM."],
		usage: {
			tokens: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 9_200_000,
			},
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 7.23 },
		},
	};
}

/**
 * What the runner hands back when pi is no longer where it was.
 *
 * Not invented. The health check refuses to spawn and answers with
 * this shape, which was confirmed against a live pi whose versioned
 * install had been deleted by an upgrade: exit 127, no text, and the
 * advisory as both stderr and warning.
 */
function pinnedToAnInstallThatIsGone(id: string): RunReviewerResult {
	const said =
		"Pi runtime stale: the running pi install at " +
		"`/Users/x/.pi/pkg/pi-0.83.0` no longer exists on disk. Pi was likely " +
		"updated (nix gc, brew upgrade, etc.) mid-session; restart pi to load " +
		"the new binary. Subagent dispatch will fail until you do.";
	return {
		reviewerId: id,
		exitCode: 127,
		finalAssistantText: "",
		stderr: said,
		warnings: [said],
	};
}

describe("a round asked after pi was upgraded out from under it", () => {
	// Measured, on this repository, on the night this was written. Pi
	// upgraded mid-session and deleted the versioned install directory
	// the running session pins its children to. All seven reviewers
	// died on dispatch, and the round said the same sentence seven
	// times with a retry hint beside it. Retrying is the one thing that
	// cannot work: it fails identically until the session restarts.
	//
	// The advisory existed the whole time. Its own docstring said
	// downstream renderers would hoist it, and nothing but its own test
	// ever read it, which is the same shape as the two fatal findings in
	// #457: a feature nothing calls is not a feature.
	function deps(): CouncilDeps {
		return {
			async ask(participant): Promise<AskAnswer> {
				return answerFromReviewer(pinnedToAnInstallThatIsGone(participant.id));
			},
			async record(findings): Promise<Finding[]> {
				return findings.map((finding, index) => ({
					...finding,
					id: index + 1,
				}));
			},
			now: () => new Date("2026-08-07T03:06:17.728Z"),
		};
	}

	it("diagnoses the round once, rather than once per reviewer", async () => {
		const { run } = await runCouncil({ roster, prompt: "p", seq: 1 }, deps());

		const said = staleRuntimeAdvisory(run);
		expect(said).toContain("restart pi");
		expect(said?.match(/pi-0\.83\.0/g)).toHaveLength(1);
	});

	it("says it once in the answer a reader is handed", async () => {
		// The measurement that matters, over the whole answer rather than
		// over the advisory: a sentence hoisted above a roll call that
		// still repeats it makes a seven-reviewer round eight copies
		// long, which is worse than the seven it set out to fix.
		const { run } = await runCouncil({ roster, prompt: "p", seq: 1 }, deps());

		const whole = roundAnswer(run)
			.map((line) => line.text)
			.join("\n");

		expect(whole.match(/pi-0\.83\.0/g)).toHaveLength(1);
		for (const participant of SEVEN) {
			expect(whole).toContain(`${participant}: as above.`);
		}
	});

	it("still says what became of each reviewer", async () => {
		// Hoisting the diagnosis must not swallow the roll call. Somebody
		// reading this has to see that all seven were asked and that none
		// of them answered, or the round looks like it never ran.
		const { run } = await runCouncil({ roster, prompt: "p", seq: 1 }, deps());

		expect(run.outcomes).toHaveLength(SEVEN.length);
		for (const outcome of run.outcomes) {
			expect(outcome.failure).toContain("Pi runtime stale");
			expect(outcome.findingIds).toEqual([]);
		}
	});

	it("does not read a failure that merely quotes an install path", async () => {
		// The mark is the health check's own prefix, not a path in a
		// message. A reviewer that failed reading a skill from the
		// install is a different event, and telling somebody to restart
		// over it costs them the session this exists to save.
		const { run } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			{
				...deps(),
				async ask(participant): Promise<AskAnswer> {
					return {
						failure: `${participant.id}: ENOENT /Users/x/.pi/pkg/pi-0.83.0/skills/foo`,
					};
				},
			},
		);

		expect(staleRuntimeAdvisory(run)).toBeUndefined();
	});
});

describe("a round in which every reviewer is stopped", () => {
	let answers: string;

	beforeEach(() => {
		answers = mkdtempSync(join(tmpdir(), "round-evidence-"));
	});
	afterEach(() => {
		rmSync(answers, { recursive: true, force: true });
	});

	/** The real composition: runner outcome, adapter, archive, round. */
	function deps(): CouncilDeps {
		return {
			async ask(participant, _prompt, context): Promise<AskAnswer> {
				const answer = answerFromReviewer(stoppedAtTheWall(participant.id));
				if ("failure" in answer) return answer;
				return {
					...answer,
					answerPath: await keepAnswer(
						answers,
						context.runId,
						participant.id,
						answer.text,
					),
				};
			},
			async record(findings): Promise<Finding[]> {
				return findings.map((finding, index) => ({
					...finding,
					id: index + 1,
				}));
			},
			now: () => new Date("2026-08-05T18:17:23.289Z"),
		};
	}

	it("says every one of them was stopped, and by what", async () => {
		const { run } = await runCouncil({ roster, prompt: "p", seq: 1 }, deps());

		expect(run.outcomes).toHaveLength(SEVEN.length);
		for (const outcome of run.outcomes) {
			expect(outcome.stopped?.limit).toBe("wall-clock");
		}
	});

	it("names the budget somebody has to change", async () => {
		// A reason nobody can act on is barely better than none. The
		// number in the message is the number in the config.
		const { warnings } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps(),
		);

		expect(warnings).toHaveLength(SEVEN.length);
		for (const warning of warnings) {
			expect(warning).toContain("2700000ms");
		}
	});

	it("never blames the reviewer's JSON for our own deadline", async () => {
		// The exact sentence that cost three deterministic retries.
		const { warnings } = await runCouncil(
			{ roster, prompt: "p", seq: 1 },
			deps(),
		);

		for (const warning of warnings) {
			expect(warning).not.toContain("JSON");
		}
	});

	it("keeps every answer, and the outcome says where", async () => {
		const { run } = await runCouncil({ roster, prompt: "p", seq: 1 }, deps());

		for (const outcome of run.outcomes) {
			const at = outcome.answerPath;
			if (at === undefined)
				throw new Error(`${outcome.participantId} kept none`);
			expect(readFileSync(at, "utf8")).toContain(outcome.participantId);
		}
	});

	it("records what the round cost even though it found nothing", async () => {
		// Cost without findings is the shape of the incident, and it is
		// what makes the next budget decision an informed one.
		const { run } = await runCouncil({ roster, prompt: "p", seq: 1 }, deps());

		const spent = run.outcomes.reduce(
			(total, outcome) => total + (outcome.usage?.cost ?? 0),
			0,
		);
		expect(spent).toBeCloseTo(7.23 * SEVEN.length, 2);
		expect(runSummary(run).findings).toBe(0);
	});

	it("does not report seven stopped reviewers as seven that answered", async () => {
		// "7/7 answered, 0 findings" was true by the letter and false in
		// every way that mattered.
		const { run } = await runCouncil({ roster, prompt: "p", seq: 1 }, deps());

		const stopped = run.outcomes.filter(
			(outcome) => outcome.stopped !== undefined,
		);
		expect(stopped).toHaveLength(SEVEN.length);
	});
});
