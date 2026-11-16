/**
 * How `runReviewer` asks a stopped reviewer for what it has: the time it
 * keeps back for the answer, the session and budget it asks in, and what
 * it keeps of both attempts.
 */

import { describe, expect, it } from "vitest";
import type { ReviewerTerminalState } from "../../../lib/subagent/artifacts.ts";
import {
	type RunPi,
	type RunPiResult,
	runReviewer,
} from "../../../lib/subagent/subagent.ts";
import { at } from "../../support/at.ts";
import { REVIEWER, review, scriptedRun } from "./fake-runs.ts";

describe("runReviewer: asking a stopped reviewer for what it has", () => {
	const ARTIFACTS = {
		runDir: "/r",
		reviewerDir: "/r/rev",
		eventsPath: "/r/rev/events.ndjson",
		stderrPath: "/r/rev/stderr.log",
		progressPath: "/r/rev/progress.json",
		resultPath: "/r/rev/result.json",
		verifiedOutputPath: "/r/rev/verified-output.json",
		sessionDir: "/r/rev/session",
		sessionPath: "/r/rev/session/s.jsonl",
	};

	/** A reviewer taken away by a clock, partway through its answer. */
	const stopped = (state: ReviewerTerminalState = "timeout"): RunPiResult => ({
		exitCode: 1,
		state,
		finalAssistantText: '{"findings": [{"subject": "the first one"}, {"sub',
		artifacts: ARTIFACTS,
	});

	describe("asking before the deadline rather than after it", () => {
		it("keeps part of the wall clock back for the answer", async () => {
			const { runPi, calls } = scriptedRun([
				{ exitCode: 0, state: "complete", finalAssistantText: "{}" },
			]);

			await review(runPi, {
				autoResume: true,
				wrapUpReserveMs: 90_000,
			});

			// A reserve rather than a deadline: only the runner knows what
			// wall clock it is being carved out of, since an unset timeout
			// here means the configured default, not the absence of one.
			expect(at(calls, 0).wrapUpReserveMs).toBe(90_000);
		});

		it("reserves nothing for a run that could never be asked", async () => {
			const { runPi, calls } = scriptedRun([
				{ exitCode: 0, state: "complete", finalAssistantText: "{}" },
			]);

			// The fleet path. Stopping one of these early would take its
			// time away and give nothing back, because there is no session
			// on disk to ask.
			await runReviewer({
				reviewer: REVIEWER,
				prompt: "do the thing",
				cwd: "/tmp/wt",
				runPi,
				autoResume: false,
			});

			expect(at(calls, 0).wrapUpReserveMs).toBeUndefined();
		});

		it("spends exactly what it reserved, above the old five-minute cap", async () => {
			// The one invariant the whole design rests on: the time taken
			// from investigating is the time handed to the answer. It held
			// only up to five minutes, because the reserve was uncapped
			// where it was taken and clamped where it was spent, and the
			// defaults hid it by being the same number. Ten minutes
			// reserved bought five, and the other five went nowhere.
			const { runPi, calls } = scriptedRun([
				stopped("soft-deadline"),
				{ exitCode: 0, state: "complete", finalAssistantText: "{}" },
			]);

			await review(runPi, {
				autoResume: true,
				timeoutMs: 2_700_000,
				wrapUpReserveMs: 600_000,
			});

			expect(at(calls, 0).wrapUpReserveMs).toBe(600_000);
			expect(at(calls, 1).timeoutMs).toBe(600_000);
		});

		it("reserves nothing when the reserve is switched off", async () => {
			// Zero is the documented off switch. Read through the usual
			// `??` it would have looked absent and handed back the
			// default, so the way to turn it off would have turned it on.
			const { runPi, calls } = scriptedRun([
				{ exitCode: 0, state: "complete", finalAssistantText: "{}" },
			]);

			await review(runPi, {
				autoResume: true,
				wrapUpReserveMs: 0,
			});

			expect(at(calls, 0).wrapUpReserveMs).toBeUndefined();
		});

		it("refuses a reserve that could never be a duration", async () => {
			// It reaches the watchdog as JSON, where NaN serializes to
			// null and every comparison against it is false except the one
			// that stops the child. An unvalidated reserve does not
			// misbehave subtly; it kills the whole roster on tick one.
			const { runPi } = scriptedRun([
				{ exitCode: 0, state: "complete", finalAssistantText: "{}" },
			]);

			await expect(
				review(runPi, {
					autoResume: true,
					wrapUpReserveMs: Number.NaN,
				}),
			).rejects.toThrow(/wrapUpReserveMs/);
		});

		it("asks a reviewer stopped at its soft deadline for what it has", async () => {
			const { runPi, calls } = scriptedRun([
				stopped("soft-deadline"),
				{
					exitCode: 0,
					state: "complete",
					finalAssistantText: '{"findings": [{"subject": "what I had"}]}',
				},
			]);

			const result = await review(runPi, {
				autoResume: true,
				wrapUpReserveMs: 90_000,
			});

			expect(calls).toHaveLength(2);
			// The whole point of the reserve: the wrap-up is allowed what
			// was kept back for it, so the two numbers cannot drift apart.
			expect(at(calls, 1).timeoutMs).toBe(90_000);
			expect(JSON.parse(result.finalAssistantText)).toEqual({
				findings: [{ subject: "what I had" }],
			});
			expect(result).toMatchObject({ wrappedUp: true });
		});
	});

	it("asks it to hand over its findings, in the session it already has", async () => {
		const { runPi, calls } = scriptedRun([
			stopped(),
			{
				exitCode: 0,
				state: "complete",
				finalAssistantText:
					'{"findings": [{"subject": "the first one"}, {"subject": "the second"}]}',
			},
		]);

		const result = await review(runPi, {
			autoResume: true,
		});

		expect(calls).toHaveLength(2);
		const args = at(calls, 1).args;
		expect(args).toContain("--session");
		expect(args[args.indexOf("--session") + 1]).toBe("/r/rev/session/s.jsonl");
		// It must ask for what is already formed, not for more work. A
		// reviewer that starts investigating again meets the same wall
		// and costs the round twice.
		expect(args.join(" ")).toMatch(
			/not.*(investigat|research|continue working)/i,
		);
		// The answer has one consumer and it parses this, so parsing is
		// the only assertion worth making. Joining the fragment onto it
		// leaves two objects where one is expected, which reads as a
		// truncated answer and can be discarded in favour of the fragment.
		expect(JSON.parse(result.finalAssistantText)).toEqual({
			findings: [{ subject: "the first one" }, { subject: "the second" }],
		});
		// The fragment is kept, apart, for a reader that can weigh them.
		expect(result.priorAssistantText).toBe(
			'{"findings": [{"subject": "the first one"}, {"sub',
		);
	});

	it("tells a verifying reviewer how its answer has to arrive", async () => {
		// Where verification is required an unverified answer is blanked,
		// so a wrap-up that never calls the tool spends the money, hears
		// the answer and throws it away for want of the one instruction
		// nobody gave it.
		const { runPi, calls } = scriptedRun([
			stopped(),
			{ exitCode: 0, state: "complete", finalAssistantText: "" },
		]);

		await review(runPi, {
			autoResume: true,
			requiresVerification: true,
			expectedVerificationStage: "council",
		});

		expect(at(calls, 1).args.join(" ")).toContain("verify_output");
	});

	it("keeps what both attempts recorded when it resumes one", async () => {
		// The resume is the path that only runs when something already
		// went wrong mid-investigation, which is exactly when a reviewer
		// has findings written down and no answer.
		const { runPi, calls } = scriptedRun([
			{
				exitCode: 1,
				finalAssistantText: "",
				journal: [{ subject: "before the drop" }],
				error: { stopReason: "error", message: "ECONNRESET" },
				artifacts: {
					runDir: "/r",
					reviewerDir: "/r/rev",
					eventsPath: "/r/rev/events.ndjson",
					stderrPath: "/r/rev/stderr.log",
					progressPath: "/r/rev/progress.json",
					resultPath: "/r/rev/result.json",
					verifiedOutputPath: "/r/rev/verified-output.json",
					sessionDir: "/r/rev/session",
					sessionPath: "/r/rev/session/s.jsonl",
				},
			},
			{
				exitCode: 0,
				state: "complete",
				finalAssistantText: '{"findings": []}',
				journal: [{ subject: "after the resume" }],
			},
		]);

		const result = await review(runPi, {
			autoResume: true,
		});

		// Its own directory, or the supervisor's pre-spawn clear would
		// delete the first attempt's journal, and the continuation
		// prompt tells the reviewer not to repeat a tool call.
		expect(at(calls, 1).reviewerId).not.toBe(at(calls, 0).reviewerId);
		expect(result.journal).toEqual([
			{ subject: "before the drop" },
			{ subject: "after the resume" },
		]);
	});

	it("does not overwrite the record of the stop", async () => {
		// The artifacts directory comes from the run and reviewer ids and
		// the result file is written by rename, so reusing both would
		// replace the stopped run's own record with one saying it
		// completed. That record is the evidence all of this exists to
		// keep, and recovery reads it.
		const { runPi, calls } = scriptedRun([
			stopped(),
			{
				exitCode: 0,
				state: "complete",
				finalAssistantText: '{"findings": []}',
			},
		]);

		await review(runPi, {
			autoResume: true,
		});

		expect(at(calls, 1).reviewerId).not.toBe(at(calls, 0).reviewerId);
		expect(at(calls, 1).reviewerId).toContain(REVIEWER.id);
	});

	it("asks for no longer than the caller allowed", async () => {
		const { runPi, calls } = scriptedRun([
			stopped(),
			{
				exitCode: 0,
				state: "complete",
				finalAssistantText: '{"findings": []}',
			},
		]);

		await review(runPi, {
			autoResume: true,
			timeoutMs: 60_000,
			idleTimeoutMs: 45_000,
		});

		expect(at(calls, 1).timeoutMs).toBeLessThanOrEqual(60_000);
		// And never an idle clock tighter than the wall it runs under.
		// Shortening an idle clock on its own is what killed six rounds
		// of working reviewers: silence is not idleness.
		expect(at(calls, 1).idleTimeoutMs).toBeLessThanOrEqual(
			at(calls, 1).timeoutMs ?? 0,
		);
	});

	it("keeps the fragment when the ask cannot even be made", async () => {
		// The runner rejects rather than returning on a spawn failure, and
		// letting that out would turn a stopped run whose words we had
		// into a bare failure with nothing kept.
		let call = 0;
		const runPi: RunPi = async () => {
			call += 1;
			if (call === 1) return stopped();
			throw new Error("spawn EAGAIN");
		};

		const result = await review(runPi, {
			autoResume: true,
		});

		expect(result.finalAssistantText).toContain("the first one");
		expect(result.state).toBe("timeout");
		expect(result.warnings.join(" ")).toMatch(/EAGAIN/);
	});

	it("still reports the pass as stopped, because it was", async () => {
		// The reviewer handed over what it had; it did not finish the
		// review. Reporting the pass as complete would be a fresh lie in
		// the same place as the old one.
		const { runPi } = scriptedRun([
			stopped(),
			{
				exitCode: 0,
				state: "complete",
				finalAssistantText: '{"findings": []}',
			},
		]);

		const result = await review(runPi, {
			autoResume: true,
		});

		expect(result.state).toBe("timeout");
	});

	it("keeps what it had already written when the wrap-up adds nothing", async () => {
		const { runPi } = scriptedRun([
			stopped(),
			{ exitCode: 1, state: "timeout", finalAssistantText: "" },
		]);

		const result = await review(runPi, {
			autoResume: true,
		});

		expect(result.finalAssistantText).toContain("the first one");
	});

	it("does not ask a reviewer the user cancelled", async () => {
		const { runPi, calls } = scriptedRun([stopped("cancelled")]);

		await review(runPi, {
			autoResume: true,
		});

		expect(calls).toHaveLength(1);
	});

	it("does not ask twice", async () => {
		const { runPi, calls } = scriptedRun([stopped(), stopped(), stopped()]);

		await review(runPi, {
			autoResume: true,
		});

		expect(calls).toHaveLength(2);
	});

	it("asks with the run's own variables, as the run had them", async () => {
		// A council's reviewer runs fenced, and its wrap-up is a pi of its
		// own, so it has to be told again rather than inherit it.
		const { runPi, calls } = scriptedRun([
			stopped(),
			{
				exitCode: 0,
				state: "complete",
				finalAssistantText: '{"findings": []}',
			},
		]);

		await review(runPi, {
			autoResume: true,
			env: { PI_SANDBOX: "strict" },
		});

		expect(calls.map((call) => call.env)).toEqual([
			{ PI_SANDBOX: "strict" },
			{ PI_SANDBOX: "strict" },
		]);
	});

	it("leaves it alone when recovery is switched off", async () => {
		const { runPi, calls } = scriptedRun([stopped()]);

		await review(runPi, {
			autoResume: false,
		});

		expect(calls).toHaveLength(1);
	});
});
