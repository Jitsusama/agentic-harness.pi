/**
 * What a round says when it is over, and in what order.
 *
 * Its own sentences were the last part of a round nothing tested. The
 * arithmetic under them had cases, the panel had cases, the store had
 * cases, and the paragraph a reader actually sees was assembled in the
 * extension where no test could reach it. Both of the bugs that only
 * the wiring showed lived there, and so did a sentence that told a
 * reader to look above it at failures printed below.
 */

import { describe, expect, it } from "vitest";
import type { AskRun, ParticipantOutcome } from "../../../lib/review/index.js";
import { roundAnswer } from "../../../lib/review/index.js";

/** A finished council of however many participants are named. */
function run(over: Partial<AskRun> = {}): AskRun {
	const outcomes = over.outcomes ?? [];
	return {
		id: "council-20260807T000000000-000001",
		round: "council",
		change: "github:Jitsusama/agentic-harness.pi#1",
		startedAt: "2026-08-07T00:00:00.000Z",
		participants: (outcomes.length > 0
			? outcomes
			: [{ participantId: "hawk" } as ParticipantOutcome]
		).map((one) => ({ id: one.participantId, model: "a-model" })),
		outcomes,
		...over,
	} as AskRun;
}

/** What a reader sees, one string per line, marks and all. */
function said(lines: { mark?: string; text: string }[]): string[] {
	return lines.map((line) =>
		line.mark === undefined ? line.text : `[${line.mark}] ${line.text}`,
	);
}

describe("what a round says when it is over", () => {
	const stale = "Pi runtime stale: /x/.pi/pkg/pi-0.83.0 is gone; restart pi.";

	it("puts the caveat above everything it changes the weight of", () => {
		// A caveat about which tree was read changes how every finding
		// below it should be judged, so it cannot come after them.
		const lines = said(
			roundAnswer(
				run({
					outcomes: [{ participantId: "hawk", findingIds: [1, 2] }],
				}),
				{ caveat: "read the working tree, not the change" },
			),
		);

		expect(lines[1]).toBe("[refused] read the working tree, not the change");
	});

	it("names the failures before saying they are the whole story", () => {
		// The sentence says "above". It was printed above the failures
		// it was talking about, which is the kind of thing only a test
		// of the whole answer can see.
		const lines = said(
			roundAnswer(
				run({
					outcomes: [
						{ participantId: "hawk", findingIds: [], failure: "it crashed" },
					],
				}),
			),
		);
		const failure = lines.findIndex((line) => line.includes("it crashed"));
		const story = lines.findIndex((line) => line.includes("whole story"));

		expect(failure).toBeGreaterThan(0);
		expect(story).toBeGreaterThan(failure);
	});

	it("does not call an open round's failures the end of it", () => {
		// The collect path reaches this: every participant carries a
		// failure saying nothing was on disk, and the warnings under it
		// say the transcripts may be somewhere else and the round is
		// left open deliberately. Calling that the whole story
		// contradicts the next line down.
		const lines = said(
			roundAnswer(
				run({
					open: true,
					outcomes: [
						{
							participantId: "hawk",
							findingIds: [],
							failure: "nothing was left behind",
						},
					],
				}),
				{ warnings: ["its transcripts may be under another state dir"] },
			),
		);

		expect(lines.join("\n")).not.toContain("whole story");
		expect(lines.join("\n")).toContain("may not be the end of it");
	});

	it("drops the diagnosis once a retry has disproved it", () => {
		// The sequence the advisory exists for ends here: pi dies
		// mid-round, the reader restarts, the reader retries, the retry
		// works. Every outcome that failed still carries the diagnosis,
		// because they did fail, and printing it over a reviewer that
		// has just answered tells somebody to restart a session they
		// have already restarted.
		const retried = run({
			outcomes: [
				{ participantId: "hawk", findingIds: [1, 2] },
				{
					participantId: "owl",
					findingIds: [],
					failure: stale,
					advisory: stale,
				},
			],
		});

		// The hoisted line specifically, not the words. A reviewer that
		// died of a stale install still says so on its own line, and
		// that line is the only record of why it failed.
		expect(said(roundAnswer(retried))).toContain(`[refused] ${stale}`);
		expect(said(roundAnswer(retried, { sessionAnswered: true }))).not.toContain(
			`[refused] ${stale}`,
		);
	});

	it("keeps a failure it can no longer hoist", () => {
		// Suppressing the advisory must not suppress the roll call. The
		// six reviewers that failed still failed, and their line is the
		// only record of it in the answer.
		const lines = said(
			roundAnswer(
				run({
					outcomes: [
						{ participantId: "hawk", findingIds: [1] },
						{
							participantId: "owl",
							findingIds: [],
							failure: stale,
							advisory: stale,
						},
					],
				}),
				{ sessionAnswered: true },
			),
		);

		expect(lines).toContain(`[failed] owl: ${stale}`);
	});

	it("gives every line its own element, notes included", () => {
		// A mark paints a line, so an element holding two would put the
		// glyph on the first and leave the second looking like prose.
		const lines = roundAnswer(
			run({
				outcomes: [
					{
						participantId: "hawk",
						findingIds: [1],
						stopped: { limit: "wall-clock", detail: "ran out of time" },
						answerPath: "/x/answers/hawk.md",
					},
				],
			}),
		);

		for (const line of lines) expect(line.text).not.toContain("\n");
		expect(lines.length).toBeGreaterThan(1);
	});

	it("does not blame failures when there were none", () => {
		// An open round nobody has answered yet has failed at nothing.
		// Telling its reader the failures are the whole story invents
		// seven that do not exist.
		const lines = said(roundAnswer(run({ open: true })));

		expect(lines.join("\n")).not.toContain("whole story");
		expect(lines.join("\n")).toContain("Nobody has answered yet");
	});

	it("says the session is at fault once, above the roll call", () => {
		const lines = said(
			roundAnswer(
				run({
					outcomes: [
						{
							participantId: "hawk",
							findingIds: [],
							failure: stale,
							advisory: stale,
						},
						{
							participantId: "owl",
							findingIds: [],
							failure: stale,
							advisory: stale,
						},
					],
				}),
			),
		);
		const whole = lines.join("\n");

		expect(whole.match(/pi-0\.83\.0/g)).toHaveLength(1);
		expect(lines).toContain("[failed] hawk: as above.");
		expect(lines).toContain("[failed] owl: as above.");
		expect(lines.indexOf(`[refused] ${stale}`)).toBeLessThan(
			lines.indexOf("[failed] hawk: as above."),
		);
	});

	it("keeps the warnings last, after everything about the round", () => {
		const lines = said(
			roundAnswer(
				run({ outcomes: [{ participantId: "hawk", findingIds: [1] }] }),
				{ warnings: ["one reviewer answered in the wrong shape"] },
			),
		);

		expect(lines.at(-1)).toBe("one reviewer answered in the wrong shape");
	});

	it("opens with the round itself, whatever else it has to say", () => {
		const lines = said(
			roundAnswer(
				run({ outcomes: [{ participantId: "hawk", findingIds: [1] }] }),
				{ caveat: "a caveat", warnings: ["a warning"] },
			),
		);

		expect(lines[0]).toContain("council-20260807T000000000-000001");
		expect(lines[0]).toContain("1/1 answered");
	});
});
