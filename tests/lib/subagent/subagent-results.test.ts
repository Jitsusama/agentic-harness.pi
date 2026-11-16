/**
 * The answer `runReviewer` reads out of a reviewer's run: its verified
 * output, its final text, and the warnings a malformed stream, a crash or
 * a non-zero exit adds.
 */

import { describe, expect, it } from "vitest";
import { assistantEvent, fakeRun, REVIEWER, review } from "./fake-runs.ts";

describe("runReviewer: result extraction", () => {
	it("captures verify_output from the raw stdout stream", async () => {
		const args = {
			stage: "council",
			output: {
				findings: [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "Stream verified",
						discussion: "Verified through stdout events.",
					},
				],
			},
		};
		const { runPi } = fakeRun({
			stdout: [
				JSON.stringify({
					type: "tool_execution_start",
					toolName: "verify_output",
					args,
				}),
				JSON.stringify({
					type: "tool_execution_end",
					toolName: "verify_output",
					result: { details: { ok: true, count: 1 } },
				}),
				assistantEvent("not parseable"),
			].join("\n"),
		});

		const result = await review(runPi, {
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			expectedVerificationStage: "council",
			requiresVerification: true,
		});

		expect(result.finalAssistantText).toContain("Stream verified");
		expect(result.verification).toMatchObject({ ok: true });
	});

	it("passes a large out-of-band verified payload through without truncation", async () => {
		// Out-of-band output already travelled on a file, past
		// the stream and text caps on purpose. The parent must
		// not re-apply its own 512 KB verified-output cap, or a
		// large-but-valid review would be dropped at the last
		// step. A payload over that cap must survive whole.
		const bigDiscussion = "x".repeat(600 * 1024);
		const { runPi } = fakeRun({
			finalAssistantText: "",
			verification: {
				called: true,
				ok: true,
				stage: "council",
				count: 1,
				outOfBand: true,
				output: {
					findings: [
						{
							location: { kind: "global" },
							label: "issue",
							subject: "Big",
							discussion: bigDiscussion,
						},
					],
				},
			},
		});

		const result = await review(runPi, {
			expectedVerificationStage: "council",
			requiresVerification: true,
		});

		expect(result.finalAssistantText).toContain(bigDiscussion);
		expect(result.verification).toMatchObject({ ok: true });
	});

	it("uses successful verify_output payload as the canonical final text", async () => {
		const { runPi } = fakeRun({
			stdout: assistantEvent("not parseable"),
			verification: {
				called: true,
				ok: true,
				stage: "council",
				count: 1,
				output: {
					findings: [
						{
							location: { kind: "global" },
							label: "issue",
							subject: "Verified subject",
							discussion: "Verified discussion",
						},
					],
				},
			},
		});

		const result = await review(runPi, {
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			requiresVerification: true,
		});

		expect(result.finalAssistantText).toContain("Verified subject");
		expect(result.finalAssistantText).not.toContain("not parseable");
		expect(result.finalAssistantText).not.toContain("```json");
		expect(result.verification).toMatchObject({ ok: true });
	});

	it("rejects verified payloads from the wrong stage", async () => {
		const { runPi } = fakeRun({
			stdout: assistantEvent(
				'```json\n{"findings":[{"location":{"kind":"global"},"label":"issue","subject":"Wrong stage","discussion":"Nope"}]}\n```',
			),
			verification: {
				called: true,
				ok: true,
				stage: "judge",
				output: { findings: [] },
			},
		});

		const result = await review(runPi, {
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			expectedVerificationStage: "council",
			requiresVerification: true,
		});

		expect(result.finalAssistantText).toBe("");
		expect(result.verification).toMatchObject({ ok: false });
		expect(result.warnings.join("\n")).toContain("wrong stage (judge)");
	});

	it("explains when verification succeeds but the payload was not captured", async () => {
		const { runPi } = fakeRun({
			stdout: assistantEvent("not parseable"),
			verification: {
				called: true,
				ok: true,
				stage: "council",
			},
		});

		const result = await review(runPi, {
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			expectedVerificationStage: "council",
			requiresVerification: true,
		});

		expect(result.finalAssistantText).toBe("");
		expect(result.warnings.join("\n")).toContain(
			"returned ok: true but the verified payload was not captured",
		);
	});

	it("uses runner canonical text when verification metadata has been stripped", async () => {
		const { runPi } = fakeRun({
			finalAssistantText: JSON.stringify({
				findings: [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "Canonical text",
						discussion: "The supervisor already materialized this payload.",
					},
				],
			}),
			verification: {
				called: true,
				ok: true,
				stage: "council",
				count: 1,
				canonicalText: true,
			},
		});

		const result = await review(runPi, {
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			expectedVerificationStage: "council",
			requiresVerification: true,
		});

		expect(result.finalAssistantText).toContain("Canonical text");
		expect(result.warnings.join("\n")).not.toContain(
			"payload was not captured",
		);
		expect(result.verification).not.toHaveProperty("output");
	});

	it("records missing required self-verification as verification state", async () => {
		const { runPi } = fakeRun({
			stdout: assistantEvent(
				'```json\n{"findings":[{"location":{"kind":"global"},"label":"issue","subject":"Unverified","discussion":"Nope"}]}\n```',
			),
		});

		const result = await review(runPi, {
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			expectedVerificationStage: "council",
			requiresVerification: true,
		});

		expect(result.finalAssistantText).toBe("");
		expect(result.verification).toMatchObject({ called: false, ok: false });
		expect(result.warnings.join("\n")).toContain("was not called");
	});

	it("ignores output that fails required self-verification", async () => {
		const { runPi } = fakeRun({
			stdout: assistantEvent(
				'```json\n{"findings":[{"location":{"kind":"global"},"label":"issue","subject":"Unverified","discussion":"Nope"}]}\n```',
			),
			verification: {
				called: true,
				ok: false,
				stage: "council",
				message: "ok: false. 1 error against stage=council",
			},
		});

		const result = await review(runPi, {
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			requiresVerification: true,
		});

		expect(result.finalAssistantText).toBe("");
		expect(result.warnings).toContainEqual(expect.stringContaining("ignored"));
	});

	it("returns the final assistant message text as finalAssistantText", async () => {
		const { runPi } = fakeRun({
			stdout: [
				assistantEvent("I'm thinking..."),
				assistantEvent(
					'```json\n{"findings": [{"location": {"kind": "global"}, "label": "issue", "subject": "X", "discussion": "Y"}]}\n```',
				),
			].join("\n"),
		});
		const result = await review(runPi);
		expect(result.finalAssistantText).toContain('"findings"');
		expect(result.finalAssistantText).toContain('"subject": "X"');
	});

	it("ignores non-assistant message_end events", async () => {
		// `message_end` for the user role and
		// `tool_result_end` events also appear on the
		// stream. Only assistant text content matters.
		// We put the non-assistant events AFTER the
		// assistant turn so that a missing role guard
		// would clobber the correct value with user text.
		const { runPi } = fakeRun({
			stdout: [
				assistantEvent("the real assistant turn"),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "user",
						content: [{ type: "text", text: "trailing user input" }],
					},
				}),
				JSON.stringify({
					type: "tool_result_end",
					message: {
						role: "tool",
						content: [{ type: "text", text: "trailing tool result" }],
					},
				}),
			].join("\n"),
		});
		const result = await review(runPi);
		expect(result.finalAssistantText).toBe("the real assistant turn");
	});

	it("concatenates multiple text content blocks in the final assistant turn", async () => {
		// Models often split their output into multiple
		// text blocks within one message. We join them
		// with newlines so the full response reaches the
		// parser intact.
		const { runPi } = fakeRun({
			stdout: JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "first" },
						{ type: "text", text: "second" },
					],
				},
			}),
		});
		const result = await review(runPi);
		expect(result.finalAssistantText).toBe("first\nsecond");
	});

	it("emits a warning for malformed JSON event lines but doesn't abort", async () => {
		// One garbled line out of thousands shouldn't
		// strand the whole reviewer output. We log the
		// warning and continue.
		const { runPi } = fakeRun({
			stdout: ["not json at all", assistantEvent("ok")].join("\n"),
		});
		const result = await review(runPi);
		expect(result.finalAssistantText).toBe("ok");
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("surfaces the real error line from a node child crash, not the internal frame", async () => {
		// A crashed reviewer's stderr leads with a useless
		// node:internal/child_process frame; the actionable
		// errno (E2BIG, EMFILE, ...) is a few lines down. The
		// surfaced "Pi stderr" warning must name the real cause
		// so a failure explains itself instead of forcing the
		// caller to guess (as happened on the ARG_MAX night).
		const { runPi } = fakeRun({
			exitCode: 1,
			stderr: [
				"node:internal/child_process:420",
				"      throw errnoException(err, 'spawn');",
				"      ^",
				"Error: spawn E2BIG",
				"    at ChildProcess.spawn (node:internal/child_process:420:11)",
			].join("\n"),
			stdout: "",
		});

		const result = await review(runPi);

		const stderrWarning = result.warnings.find((w) =>
			w.startsWith("Pi stderr:"),
		);
		expect(stderrWarning).toBeDefined();
		expect(stderrWarning).toContain("E2BIG");
	});

	it("surfaces verified payloads from non-zero reviewer runs with a warning", async () => {
		const { runPi } = fakeRun({
			exitCode: 1,
			stderr: "model API timeout",
			stdout: assistantEvent("partial prose"),
			verification: {
				called: true,
				ok: true,
				stage: "council",
				output: {
					findings: [
						{
							location: { kind: "global" },
							label: "issue",
							subject: "Verified despite exit",
							discussion: "The verified payload is still usable.",
						},
					],
				},
			},
		});

		const result = await review(runPi, {
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			expectedVerificationStage: "council",
			requiresVerification: true,
		});

		expect(result.finalAssistantText).toContain("Verified despite exit");
		expect(result.warnings).toContainEqual(
			expect.stringMatching(/exit 1|non-zero/i),
		);
	});

	it("surfaces a non-zero exitCode as a warning while still returning the captured text", async () => {
		// A reviewer that crashed mid-stream still produced
		// some output. The caller decides whether to use
		// the partial result; we just carry the signal.
		const { runPi } = fakeRun({
			stdout: assistantEvent("partial"),
			stderr: "model API timeout",
			exitCode: 1,
		});
		const result = await review(runPi);
		expect(result.exitCode).toBe(1);
		expect(result.finalAssistantText).toBe("partial");
		expect(result.warnings).toContainEqual(
			expect.stringMatching(/exit 1|non-zero/i),
		);
		expect(result.stderr).toContain("timeout");
	});

	it("surfaces the first line of pi's stderr in warnings on non-zero exit", async () => {
		// Pi's actual error message (e.g. "Model X not
		// found") is the most useful clue when a reviewer
		// crashes. Without it the warnings dead-end at
		// "exit 1" and the user has no way to diagnose.
		// One line is enough: pi tracebacks tend to be
		// noise after the first message.
		const { runPi } = fakeRun({
			stdout: "",
			stderr:
				'Error: Model "anthropic:claude-opus-4-7" not found. Use --list-models to see available models.\n  at resolveModel (/.../foo.js:42)\n',
			exitCode: 1,
		});
		const result = await review(runPi);
		const stderrWarning = result.warnings.find((w) =>
			w.startsWith("Pi stderr:"),
		);
		expect(stderrWarning).toBeDefined();
		expect(stderrWarning).toContain(
			'Model "anthropic:claude-opus-4-7" not found',
		);
		expect(stderrWarning).not.toContain("resolveModel");
	});

	it("omits the stderr warning when stderr is empty even on non-zero exit", async () => {
		// A subprocess that crashes without printing
		// anything to stderr (rare but possible: signal
		// kill, OOM, etc.) gets the exit-code warning but
		// not a dangling "Pi stderr:" line.
		const { runPi } = fakeRun({
			stdout: "",
			stderr: "",
			exitCode: 137,
		});
		const result = await review(runPi);
		expect(result.warnings).not.toContainEqual(
			expect.stringMatching(/^Pi stderr:/),
		);
	});

	it("does not surface stderr in warnings when exit code is 0", async () => {
		// Pi sometimes prints to stderr on success (info
		// banners, deprecation warnings). Only crash-time
		// stderr earns a warning entry.
		const { runPi } = fakeRun({
			stdout: assistantEvent("{}"),
			stderr: "pi: deprecation notice for tool foo",
			exitCode: 0,
		});
		const result = await review(runPi);
		expect(result.warnings).not.toContainEqual(
			expect.stringMatching(/^Pi stderr:/),
		);
		expect(result.stderr).toContain("deprecation notice");
	});

	it("returns reviewerId from the input config so callers can correlate results", async () => {
		// Multiple reviewers run concurrently. The id on
		// the result is what ties findings back to the
		// reviewer that produced them.
		const { runPi } = fakeRun({
			stdout: assistantEvent("{}"),
		});
		const result = await review(runPi, {
			reviewer: { ...REVIEWER, id: "council-skeptic" },
		});
		expect(result.reviewerId).toBe("council-skeptic");
	});
});
