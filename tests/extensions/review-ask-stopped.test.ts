/**
 * A reviewer we stopped is not a reviewer that answered badly.
 *
 * Six council rounds over two days spent $150 and lost $93 of it to
 * reviewers reported as having answered with unparseable JSON. None of
 * them had answered. Every one had been killed at a fifteen-minute wall
 * clock, and what got harvested was the conversational line each had
 * said between tool calls on its way to being stopped, which is never
 * JSON and was never meant to be.
 *
 * This is the seam where that judgement is made, so this is where the
 * distinction is pinned.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	answerFromReviewer,
	keepAnswer,
	reviewerRunner,
} from "../../extensions/review-integration/reviewer.js";
import type { RunReviewerResult } from "../../lib/subagent/index.js";

/** A runner outcome, with the fields a caller always gets. */
function ran(over: Partial<RunReviewerResult> = {}): RunReviewerResult {
	return {
		reviewerId: "hawk",
		exitCode: 0,
		finalAssistantText: "",
		stderr: "",
		warnings: [],
		...over,
	};
}

/** The wire shape a reviewer answers with, carrying one finding. */
const FOUND = JSON.stringify({
	findings: [
		{
			location: { kind: "file", file: "lib/a.ts" },
			label: "issue",
			subject: "This leaks",
		},
	],
});

describe("a reviewer that finished", () => {
	it("answers with its text", () => {
		const answer = answerFromReviewer(
			ran({ finalAssistantText: FOUND, state: "complete" }),
		);

		expect(answer).toEqual({ text: FOUND });
	});

	it("carries what it cost, when the runner measured it", () => {
		const answer = answerFromReviewer(
			ran({
				finalAssistantText: FOUND,
				state: "complete",
				usage: {
					tokens: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						total: 15,
					},
					cost: {
						input: 0.1,
						output: 0.2,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0.3,
					},
				},
			}),
		);

		expect(answer).toMatchObject({ usage: { tokens: 15, cost: 0.3 } });
	});
});

describe("a reviewer we stopped", () => {
	const LIMITS = [
		["timeout", "wall-clock"],
		["idle-timeout", "idle"],
		["output-limit", "output"],
		["cancelled", "cancelled"],
		["parent-exit", "parent-exit"],
	] as const;

	for (const [state, limit] of LIMITS) {
		it(`reads ${state} as the ${limit} limit`, () => {
			const answer = answerFromReviewer(
				ran({
					exitCode: 124,
					finalAssistantText: "Let me check what the tests assume.",
					state,
					warnings: [`Pi subprocess ${state}; sent SIGTERM.`],
				}),
			);

			expect(answer).toMatchObject({ stopped: { limit } });
		});
	}

	it("is a stop even when it was cut off before saying anything", () => {
		// The old guard called an empty non-zero run a failure, which
		// reads as "the model was unavailable" when in fact it worked
		// for fifteen minutes and we took it away.
		const answer = answerFromReviewer(
			ran({ exitCode: 124, finalAssistantText: "", state: "timeout" }),
		);

		expect(answer).toMatchObject({ stopped: { limit: "wall-clock" } });
		expect(answer).not.toHaveProperty("failure");
	});

	it("keeps the findings it had already produced", () => {
		const answer = answerFromReviewer(
			ran({ exitCode: 124, finalAssistantText: FOUND, state: "output-limit" }),
		);

		expect(answer).toMatchObject({ text: FOUND, stopped: { limit: "output" } });
	});

	it("explains itself in the runner's own words", () => {
		const answer = answerFromReviewer(
			ran({
				exitCode: 124,
				state: "timeout",
				warnings: ["Pi subprocess timed out after 900000ms; sent SIGTERM."],
			}),
		);

		expect(answer).toMatchObject({
			stopped: { detail: expect.stringContaining("900000ms") },
		});
	});
});

describe("a reviewer that never ran", () => {
	it("is a failure, not a stop", () => {
		// Nothing was spent and nothing was taken away: the model was
		// unavailable. Reporting that as a stop would send somebody to
		// raise a budget that was never reached.
		const answer = answerFromReviewer(
			ran({
				exitCode: 1,
				state: "failed",
				warnings: ["Pi subprocess exited non-zero (exit 1)"],
				stderr: "overloaded_error",
			}),
		);

		expect(answer).toHaveProperty("failure");
		expect(answer).not.toHaveProperty("stopped");
	});

	it("says what the runner said about it", () => {
		const answer = answerFromReviewer(
			ran({ exitCode: 1, state: "failed", stderr: "overloaded_error" }),
		);

		expect(answer).toMatchObject({
			failure: expect.stringContaining("overloaded_error"),
		});
	});

	it("names the participant when the runner said nothing useful", () => {
		const answer = answerFromReviewer(ran({ exitCode: 1, state: "failed" }));

		expect(answer).toMatchObject({
			failure: expect.stringContaining("hawk"),
		});
	});
});

describe("the runner a round's reviewers run on", () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "review-transcripts-"));
	});
	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("leaves a reviewer's artifacts under the round that paid for them", async () => {
		// The claim this pins is the one the whole change rests on, and
		// it was previously checked by grepping this module's source for
		// the name of a constant. That proves the words are present and
		// nothing about what runs: swapping back to the fire-and-forget
		// runner, which writes nothing anywhere, would leave every other
		// test in this repository green.
		// A supervisor that starts and immediately exits. The run
		// settles on its own, so nothing is left holding a timer after
		// the test returns; what is asserted is what it laid down on
		// disk before it went.
		const closers: ((code: number | null) => void)[] = [];
		const runner = reviewerRunner(
			{ node: "/pi/bin/node", entry: "/pi/dist/cli.js" },
			stateDir,
			() => {
				queueMicrotask(() => {
					for (const close of closers) close(1);
				});
				return {
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					on: () => undefined,
					once: (event: string, listener: (code: number | null) => void) => {
						if (event === "close") closers.push(listener);
					},
					kill: () => true,
				} as never;
			},
		);

		await runner({
			args: [],
			cwd: stateDir,
			runId: "council-20260805T181723289-000001",
			reviewerId: "gitstream-test",
		});

		expect(
			existsSync(
				join(
					stateDir,
					"runs",
					"council-20260805T181723289-000001",
					"reviewers",
					"gitstream-test",
				),
			),
		).toBe(true);
	});
});

describe("keeping what a reviewer said", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "review-answers-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("writes the answer verbatim and says where it put it", async () => {
		const at = await keepAnswer(root, "council-1", "hawk", FOUND);

		expect(readFileSync(at, "utf8")).toBe(FOUND);
	});

	it("keeps an answer nothing could be read from, which is the point", async () => {
		// An answer that parsed is already represented by its findings.
		// The one worth keeping is the one that did not, because that is
		// the only record of what was paid for.
		const at = await keepAnswer(root, "council-1", "hawk", "Let me check.");

		expect(readFileSync(at, "utf8")).toBe("Let me check.");
	});

	it("files each participant separately under its round", async () => {
		const hawk = await keepAnswer(root, "council-1", "hawk", "from hawk");
		const owl = await keepAnswer(root, "council-1", "owl", "from owl");

		expect(hawk).not.toBe(owl);
		expect(readFileSync(hawk, "utf8")).toBe("from hawk");
		expect(readFileSync(owl, "utf8")).toBe("from owl");
	});

	it("survives a participant id that is not a safe file name", async () => {
		// Ids come from config, so they are whatever somebody wrote. One
		// carrying a slash would otherwise write outside its round, or
		// fail the whole round for a naming choice.
		const at = await keepAnswer(root, "council-1", "../../escape", "contained");

		expect(at.startsWith(root)).toBe(true);
		expect(readFileSync(at, "utf8")).toBe("contained");
	});
});

describe("a runner that classifies nothing", () => {
	it("still answers with text when there is text", () => {
		// The unsupervised runner never knew how a run ended. It must
		// keep working rather than having a stop invented for it.
		const answer = answerFromReviewer(ran({ finalAssistantText: FOUND }));

		expect(answer).toEqual({ text: FOUND });
	});

	it("still calls an empty non-zero run a failure", () => {
		const answer = answerFromReviewer(
			ran({ exitCode: 1, finalAssistantText: "", stderr: "boom" }),
		);

		expect(answer).toMatchObject({ failure: expect.stringContaining("boom") });
	});
});
