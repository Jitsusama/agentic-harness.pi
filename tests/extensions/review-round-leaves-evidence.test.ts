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
import { runCouncil, runSummary } from "../../lib/review/index.js";
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
