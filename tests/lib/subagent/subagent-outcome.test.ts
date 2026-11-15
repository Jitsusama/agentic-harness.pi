/**
 * What `runReviewer` says of how a run ended: the terminal state, the
 * sessions it billed under, and a model-stream error it surfaces.
 */

import { describe, expect, it } from "vitest";
import { mergeResumeOutcome, mergeWrapUpOutcome, type RunReviewerResult } from "../../../lib/subagent/subagent.ts";
import { review, assistantEvent, fakeRun, scriptedRun } from "./fake-runs.ts";

describe("runReviewer: how a run ended", () => {
	it("carries the runner's terminal state through to the caller", async () => {
		// The caller decides whether a reviewer was stopped or answered
		// badly, and it decides on this field. Dropping it here would
		// leave the supervisor classifying a stop that nobody reads.
		const { runPi } = fakeRun({
			exitCode: 124,
			finalAssistantText: "Let me check the tests.",
			state: "timeout",
		});

		const result = await review(runPi);

		expect(result.state).toBe("timeout");
	});

	it("leaves the state absent for a runner that never classified one", async () => {
		const { runPi } = fakeRun({ exitCode: 0, finalAssistantText: "{}" });

		const result = await review(runPi);

		expect(result.state).toBeUndefined();
	});
});

describe("runReviewer: which sessions a run billed under", () => {
	// The AI proxy bills every request under the pi session that made it,
	// so these ids are how a run joins its bill exactly.
	const SESSION = "01a0cff2-4244-75ad-b91b-7bdc1bc970b7";
	const LATER = "01a0cff9-7f1e-7c2a-9d3e-2a1b8e0c4f51";

	it("carries the sessions a supervised runner watched its child announce", async () => {
		const { runPi } = scriptedRun([
			{ exitCode: 0, finalAssistantText: "{}", sessionIds: [SESSION] },
		]);

		const result = await review(runPi);

		expect(result.sessionIds).toEqual([SESSION]);
	});

	it("reads the session out of a raw stream when the runner hands one back", async () => {
		const { runPi } = fakeRun({
			stdout: [
				JSON.stringify({ type: "session", version: 3, id: SESSION, cwd: "/" }),
				assistantEvent("{}"),
			].join("\n"),
		});

		const result = await review(runPi);

		expect(result.sessionIds).toEqual([SESSION]);
	});

	it("says it does not know when the runner could not say", async () => {
		// A runner that extracted the answer itself and reported no
		// sessions saw a stream this cannot; guessing none would read as
		// a run with no process.
		const { runPi } = scriptedRun([{ exitCode: 0, finalAssistantText: "{}" }]);

		const result = await review(runPi);

		expect(result.sessionIds).toBeNull();
	});

	const settled = (
		sessionIds: readonly string[] | null,
	): RunReviewerResult => ({
		reviewerId: "r",
		exitCode: 0,
		finalAssistantText: "{}",
		stderr: "",
		warnings: [],
		sessionIds,
	});

	it("keeps both sessions when a stopped reviewer is asked for its findings", () => {
		const merged = mergeWrapUpOutcome(settled([SESSION]), settled([LATER]));
		expect(merged.sessionIds).toEqual([SESSION, LATER]);
	});

	it("keeps both sessions when a dropped reviewer is resumed", () => {
		const merged = mergeResumeOutcome(settled([SESSION]), settled([LATER]));
		expect(merged.sessionIds).toEqual([SESSION, LATER]);
	});

	it("names a resumed session once, since the resume continues the same one", () => {
		// A resume runs --session on the first attempt's file, so its
		// process announces the session the first one already did. Listed
		// twice it would read as two sessions on the bill.
		const merged = mergeResumeOutcome(settled([SESSION]), settled([SESSION]));
		expect(merged.sessionIds).toEqual([SESSION]);
	});

	it("does not know the whole list when it does not know one half", () => {
		// A partial list would join the run to less than its bill and say
		// nothing about the rest.
		expect(
			mergeWrapUpOutcome(settled([SESSION]), settled(null)).sessionIds,
		).toBeNull();
		expect(
			mergeResumeOutcome(settled(null), settled([LATER])).sessionIds,
		).toBeNull();
	});
});

describe("runReviewer: reviewer error surfacing", () => {
	it("carries a terminal model-stream error and names it in a warning", async () => {
		// A reviewer can do a full investigation and then have
		// its final synthesis turn die when the provider drops
		// the stream. The child still exits 0, so without an
		// explicit error signal the drop reads as a clean run
		// that merely forgot to verify. runReviewer must carry
		// the structured error through and name it, so the
		// dropped reviewer is distinguishable from a reviewer
		// that finished but never called verify_output.
		const { runPi } = fakeRun({
			exitCode: 0,
			finalAssistantText: "",
			error: {
				stopReason: "error",
				message:
					"OpenAI Responses stream ended before a terminal response event",
			},
		});
		const result = await review(runPi, {
			requiresVerification: true,
		});
		expect(result.error?.stopReason).toBe("error");
		expect(result.error?.message).toContain("stream ended");
		expect(result.warnings).toContainEqual(
			expect.stringMatching(/stream.*transient|transient.*stream/is),
		);
	});
});
