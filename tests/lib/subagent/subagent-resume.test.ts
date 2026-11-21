/**
 * How `runReviewer` resumes a reviewer once after a transient error, and
 * when it does not.
 */

import { describe, expect, it } from "vitest";
import { wrapUpAsked } from "../../../lib/subagent/follow-up.ts";
import {
	clearSubagentDefaults,
	registerSubagentDefaultExtension,
} from "../../../lib/subagent/index.ts";
import type {
	ReviewerError,
	RunPiResult,
} from "../../../lib/subagent/subagent.ts";
import { at } from "../../support/at.ts";
import { REVIEWER, review, scriptedRun } from "./fake-runs.ts";

const TRANSIENT: ReviewerError = {
	stopReason: "error",
	message: "OpenAI Responses stream ended before a terminal response event",
};

// A fenced session's child reopened is still one whose folder's `.pi` a
// fenced command may have written, so each follow-up keeps ignoring it.
describe("a fenced session's child followed up", () => {
	it("keeps ignoring the folder's own .pi when it is resumed", async () => {
		const { runPi, calls } = scriptedRun([
			{
				exitCode: 0,
				finalAssistantText: "",
				error: TRANSIENT,
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
			{ exitCode: 0, finalAssistantText: "done" },
		]);
		await review(runPi, { ignoreProject: true });
		expect(calls).toHaveLength(2);
		expect(at(calls, 0).args).toContain("--no-approve");
		expect(at(calls, 1).args).toContain("--session");
		expect(at(calls, 1).args).toContain("--no-approve");
	});

	it("keeps ignoring the folder's own .pi when it is asked to wrap up", () => {
		const asked = wrapUpAsked(
			{ reviewer: REVIEWER, ignoreProject: true },
			"/r/rev/session/s.jsonl",
			[],
			[],
		);
		expect(asked.args).toContain("--session");
		expect(asked.args).toContain("--no-approve");
	});
});

describe("runReviewer: auto-resume", () => {
	it("resumes once from the session after a transient error and returns the verified outcome", async () => {
		const { runPi, calls } = scriptedRun([
			{
				exitCode: 0,
				finalAssistantText: "",
				error: TRANSIENT,
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
				finalAssistantText: "",
				verification: {
					called: true,
					ok: true,
					outOfBand: true,
					stage: "council",
					output: { findings: [] },
				},
			},
		]);
		const result = await review(runPi, {
			requiresVerification: true,
			expectedVerificationStage: "council",
		});
		expect(calls).toHaveLength(2);
		const resumeArgs = at(calls, 1).args;
		expect(resumeArgs).toContain("--session");
		expect(resumeArgs[resumeArgs.indexOf("--session") + 1]).toBe(
			"/r/rev/session/s.jsonl",
		);
		expect(resumeArgs).not.toContain("--no-session");
		expect(result.verification).toMatchObject({ ok: true });
		expect(result.error).toBeUndefined();
		expect(result.warnings).toContainEqual(expect.stringMatching(/resum/i));
	});

	it("resumes with the run's own variables, as the run had them", async () => {
		const { runPi, calls } = scriptedRun([
			{
				exitCode: 0,
				finalAssistantText: "",
				error: TRANSIENT,
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
			{ exitCode: 0, finalAssistantText: '{"findings": []}' },
		]);
		await review(runPi, {
			env: { PI_SANDBOX: "strict" },
		});
		expect(calls).toHaveLength(2);
		expect(at(calls, 1).env).toEqual({ PI_SANDBOX: "strict" });
	});

	it("resumes at most once and surfaces the error when the resume also fails", async () => {
		const withSession: RunPiResult = {
			exitCode: 0,
			finalAssistantText: "",
			error: TRANSIENT,
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
		};
		const { runPi, calls } = scriptedRun([withSession, withSession]);
		const result = await review(runPi, {
			requiresVerification: true,
		});
		expect(calls).toHaveLength(2);
		expect(result.error?.stopReason).toBe("error");
	});

	it("does not resume a fatal error", async () => {
		const { runPi, calls } = scriptedRun([
			{
				exitCode: 0,
				finalAssistantText: "",
				error: { stopReason: "error", message: "No API key found for openai" },
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
		]);
		const result = await review(runPi, {
			requiresVerification: true,
		});
		expect(calls).toHaveLength(1);
		expect(result.error?.message).toContain("No API key");
	});

	it("carries the registered default extension into the resume dispatch", async () => {
		// The credential-providing extension is registered as a
		// subagent default so it survives isolation. A resume
		// must inherit it too, or the resumed reviewer cannot
		// authenticate. Credentials are fetched live by that
		// extension on each call, so nothing is snapshotted.
		clearSubagentDefaults();
		registerSubagentDefaultExtension("/abs/creds.ts");
		try {
			const { runPi, calls } = scriptedRun([
				{
					exitCode: 0,
					finalAssistantText: "",
					error: TRANSIENT,
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
				{ exitCode: 0, finalAssistantText: "", error: TRANSIENT },
			]);
			await review(runPi, {
				requiresVerification: true,
			});
			expect(calls).toHaveLength(2);
			const resumeArgs = at(calls, 1).args;
			expect(resumeArgs).toContain("--extension");
			expect(resumeArgs).toContain("/abs/creds.ts");
		} finally {
			clearSubagentDefaults();
		}
	});

	it("does not resume when no session was persisted", async () => {
		const { runPi, calls } = scriptedRun([
			{ exitCode: 0, finalAssistantText: "", error: TRANSIENT },
		]);
		const result = await review(runPi, {
			requiresVerification: true,
		});
		expect(calls).toHaveLength(1);
		expect(result.error?.stopReason).toBe("error");
	});

	const SESSION_ARTIFACTS = {
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

	it("does not resume a first attempt that already verified", async () => {
		// A verified result is good; a transient error flag on
		// the same run must not trigger a resume that could
		// replace it with a failed one.
		const { runPi, calls } = scriptedRun([
			{
				exitCode: 0,
				finalAssistantText: "",
				error: TRANSIENT,
				verification: {
					called: true,
					ok: true,
					outOfBand: true,
					stage: "council",
					output: { findings: [] },
				},
				artifacts: SESSION_ARTIFACTS,
			},
		]);
		const result = await review(runPi, {
			requiresVerification: true,
			expectedVerificationStage: "council",
		});
		expect(calls).toHaveLength(1);
		expect(result.verification).toMatchObject({ ok: true });
	});

	it("does not resume when the abort signal has fired", async () => {
		const controller = new AbortController();
		controller.abort();
		const { runPi, calls } = scriptedRun([
			{
				exitCode: 0,
				finalAssistantText: "",
				error: TRANSIENT,
				artifacts: SESSION_ARTIFACTS,
			},
		]);
		const result = await review(runPi, {
			requiresVerification: true,
			signal: controller.signal,
		});
		expect(calls).toHaveLength(1);
		expect(result.error?.stopReason).toBe("error");
	});

	it("requests session persistence only when autoResume is enabled", async () => {
		const { runPi: onRunPi, calls: onCalls } = scriptedRun([
			{ exitCode: 0, finalAssistantText: "", verification: undefined },
		]);
		await review(onRunPi);
		expect(onCalls[0]).toMatchObject({ persistSession: true });

		const { runPi: offRunPi, calls: offCalls } = scriptedRun([
			{ exitCode: 0, finalAssistantText: "" },
		]);
		await review(offRunPi, {
			autoResume: false,
		});
		expect(offCalls[0]).toMatchObject({ persistSession: false });
	});
});
