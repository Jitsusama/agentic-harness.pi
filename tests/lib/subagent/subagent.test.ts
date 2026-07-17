import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type CouncilReviewer,
	type ReviewerError,
	type ReviewerVerification,
	type RunPi,
	type RunPiResult,
	runReviewer,
} from "../../../lib/subagent/subagent.js";

/**
 * `runReviewer` spawns a separate pi process as a full
 * agentic harness for each council reviewer. The reviewer
 * gets its own context window, tools, and model. Output
 * is line-delimited JSON events on stdout; we extract the
 * final assistant turn's text content so the parser
 * (parse.ts) can pull findings out of it.
 *
 * These tests inject a fake `runPi` that returns canned
 * stdout. They verify:
 *   - The pi CLI args composed for each reviewer config.
 *   - The cwd handed to runPi (must be the worktree path).
 *   - That the last assistant message's text is what
 *     gets surfaced.
 *   - Warnings for malformed events and non-zero exits.
 */

const REVIEWER: CouncilReviewer = {
	id: "council-fast",
	model: "anthropic/claude-sonnet-4-5",
	tools: ["read", "grep", "glob", "ls", "bash"],
};

function assistantEvent(text: string): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
		},
	});
}

function fakeRun(result: {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	finalAssistantText?: string;
	verification?: ReviewerVerification;
	error?: ReviewerError;
}): { runPi: RunPi; calls: Array<{ args: string[]; cwd: string }> } {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const runPi: RunPi = async (opts) => {
		calls.push({ args: opts.args, cwd: opts.cwd });
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.exitCode ?? 0,
			...(result.finalAssistantText !== undefined
				? { finalAssistantText: result.finalAssistantText }
				: {}),
			...(result.verification ? { verification: result.verification } : {}),
			...(result.error ? { error: result.error } : {}),
		};
	};
	return { runPi, calls };
}

describe("runReviewer — reviewer error surfacing", () => {
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
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "review this diff",
			cwd: "/tmp/wt",
			runPi,
			requiresVerification: true,
		});
		expect(result.error?.stopReason).toBe("error");
		expect(result.error?.message).toContain("stream ended");
		expect(
			result.warnings.some((w) => /stream/i.test(w) && /transient/i.test(w)),
		).toBe(true);
	});
});

// Returns each queued RunPiResult on successive calls (the
// last repeats), recording the args of every call so a test
// can assert the resume dispatch shape.
function scriptedRun(results: RunPiResult[]): {
	runPi: RunPi;
	calls: Array<{ args: string[]; cwd: string }>;
} {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const runPi: RunPi = async (opts) => {
		calls.push({ args: opts.args, cwd: opts.cwd });
		const index = Math.min(calls.length - 1, results.length - 1);
		return results[index];
	};
	return { runPi, calls };
}

const TRANSIENT: ReviewerError = {
	stopReason: "error",
	message: "OpenAI Responses stream ended before a terminal response event",
};

describe("runReviewer — auto-resume", () => {
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
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "review this diff",
			cwd: "/tmp/wt",
			runPi,
			requiresVerification: true,
			expectedVerificationStage: "council",
		});
		expect(calls).toHaveLength(2);
		const resumeArgs = calls[1].args;
		expect(resumeArgs).toContain("--session");
		expect(resumeArgs[resumeArgs.indexOf("--session") + 1]).toBe(
			"/r/rev/session/s.jsonl",
		);
		expect(resumeArgs).not.toContain("--no-session");
		expect(result.verification?.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.warnings.some((w) => /resum/i.test(w))).toBe(true);
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
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
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
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
			requiresVerification: true,
		});
		expect(calls).toHaveLength(1);
		expect(result.error?.message).toContain("No API key");
	});

	it("does not resume when no session was persisted", async () => {
		const { runPi, calls } = scriptedRun([
			{ exitCode: 0, finalAssistantText: "", error: TRANSIENT },
		]);
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
			requiresVerification: true,
		});
		expect(calls).toHaveLength(1);
		expect(result.error?.stopReason).toBe("error");
	});
});

describe("runReviewer — argument composition", () => {
	it("passes the reviewer model via --model and tools via --tools (csv)", async () => {
		// pi --mode json --no-session -p --model X --tools T1,T2 PROMPT
		// is the established shape from the subagent
		// example. Tools join with commas so a single
		// --tools flag carries the whole palette.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{"findings": []}`),
		});
		await runReviewer({
			reviewer: REVIEWER,
			prompt: "review this diff",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(calls).toHaveLength(1);
		const args = calls[0].args;
		expect(args).toContain("--mode");
		expect(args[args.indexOf("--mode") + 1]).toBe("json");
		expect(args).toContain("--no-session");
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe(
			"anthropic/claude-sonnet-4-5",
		);
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe(
			"read,grep,glob,ls,bash,verify_output",
		);
	});

	it("appends verify_output to a tools palette that doesn't already list it", async () => {
		// Pi's --tools flag is an allowlist that applies to
		// extension tools too. The reviewer prompt instructs
		// the subagent to call verify_output, so the
		// dispatcher must guarantee it's in the palette
		// even when the caller forgets.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{}`),
		});
		await runReviewer({
			reviewer: { id: "narrow", tools: ["read"] },
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		const args = calls[0].args;
		expect(args[args.indexOf("--tools") + 1]).toBe("read,verify_output");
	});

	it("does not duplicate verify_output when the palette already includes it", async () => {
		// Defensive: if a caller does include verify_output
		// explicitly, the dispatcher should leave it where
		// it sits and not append a second copy.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{}`),
		});
		await runReviewer({
			reviewer: {
				id: "explicit",
				tools: ["read", "verify_output", "grep"],
			},
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		const args = calls[0].args;
		expect(args[args.indexOf("--tools") + 1]).toBe("read,verify_output,grep");
	});

	it("omits --tools entirely when the palette is empty so pi falls back to its default", async () => {
		// Empty palette means "inherit pi's defaults" (all
		// loaded tools). In that mode pi allows verify_output
		// because it's part of the loaded pr-workflow-verify
		// extension, so we don't need to force a --tools
		// flag just to keep the verify path open.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{}`),
		});
		await runReviewer({
			reviewer: { id: "defaults" },
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(calls[0].args).not.toContain("--tools");
	});

	it("uses the worktree path as the subprocess cwd", async () => {
		// Reviewers investigate in the worktree, not in
		// the parent pi's cwd. Tools they spawn (grep,
		// read, bash) must run in the PR's checkout.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{"findings": []}`),
		});
		await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/pi-state/worktrees/o-r/sha",
			runPi,
		});
		expect(calls[0].cwd).toBe("/tmp/pi-state/worktrees/o-r/sha");
	});

	it("passes the prompt as an @file reference in the final positional, not inline on argv", async () => {
		// The whole prompt (persona standard plus every
		// inlined PR diff on a stack review) can exceed macOS
		// ARG_MAX (1,048,576 bytes). Passing it as a
		// command-line argument crashes the reviewer's pi
		// child at spawn. Pi merges an @file reference into
		// the prompt, so runReviewer writes the prompt to a
		// temp file and passes @<path> as the final
		// positional, keeping argv tiny regardless of size.
		const prompt = "Review the diff at hand";
		let promptArg: string | undefined;
		let fileContent: string | undefined;
		const runPi: RunPi = async (opts) => {
			promptArg = opts.args[opts.args.length - 1];
			if (promptArg?.startsWith("@")) {
				fileContent = readFileSync(promptArg.slice(1), "utf-8");
			}
			return {
				stdout: assistantEvent(`{"findings": []}`),
				stderr: "",
				exitCode: 0,
			};
		};
		await runReviewer({
			reviewer: REVIEWER,
			prompt,
			cwd: "/tmp/wt",
			runPi,
		});
		// The final positional is an @<path> reference, not
		// the raw prompt, and the referenced file holds the
		// prompt verbatim.
		expect(promptArg?.startsWith("@")).toBe(true);
		expect(promptArg).not.toBe(prompt);
		expect(fileContent).toBe(prompt);
		// The temp file is cleaned up once the run resolves.
		expect(existsSync(promptArg?.slice(1) ?? "")).toBe(false);
	});

	it("passes each extra extension path via --extension", async () => {
		// The parent injects sibling extensions (e.g. the
		// pr-workflow-verify tool surface) into every
		// reviewer subagent so the model can self-validate
		// its output before ending. Each path goes through
		// as a separate `--extension <path>` pair so pi's
		// CLI parser sees them as repeated, not as one
		// concatenated value.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{"findings": []}`),
		});
		await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			extraExtensions: [
				"/abs/path/to/pr-workflow-verify/index.ts",
				"/abs/path/to/another-extension/index.ts",
			],
			runPi,
		});
		const args = calls[0].args;
		const extensionFlagPositions: number[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--extension") extensionFlagPositions.push(i);
		}
		expect(extensionFlagPositions).toHaveLength(2);
		expect(args[extensionFlagPositions[0] + 1]).toBe(
			"/abs/path/to/pr-workflow-verify/index.ts",
		);
		expect(args[extensionFlagPositions[1] + 1]).toBe(
			"/abs/path/to/another-extension/index.ts",
		);
	});

	it("omits --extension entirely when no extraExtensions are supplied", async () => {
		// Older callers and the default path don't pass
		// extensions through; we keep pi's default extension
		// discovery in that case.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{"findings": []}`),
		});
		await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(calls[0].args).not.toContain("--extension");
	});

	it("omits --model and --tools when the reviewer config doesn't specify them", async () => {
		// Fallback to pi's defaults (whatever the user has
		// configured in their session). The dispatcher
		// only forces flags the reviewer explicitly opts
		// into.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{"findings": []}`),
		});
		await runReviewer({
			reviewer: { id: "bare" },
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		const args = calls[0].args;
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--tools");
		expect(args).not.toContain("--thinking");
	});

	it("passes --thinking <level> when thinkingLevel is set", async () => {
		// Each reviewer can request its own pi thinking
		// level (off / low / medium / high). The dispatcher
		// forwards it as `--thinking <level>` so pi runs the
		// subagent at the requested depth instead of
		// inheriting the parent session's default.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{"findings": []}`),
		});
		await runReviewer({
			reviewer: {
				id: "deep",
				model: "anthropic/claude-opus-4-7",
				thinkingLevel: "high",
			},
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		const args = calls[0].args;
		expect(args).toContain("--thinking");
		expect(args[args.indexOf("--thinking") + 1]).toBe("high");
	});

	it("omits --thinking when thinkingLevel is not set", async () => {
		// Reviewers without thinkingLevel inherit pi's
		// session default; the dispatcher leaves the flag
		// off entirely rather than forcing a level.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{"findings": []}`),
		});
		await runReviewer({
			reviewer: {
				id: "default",
				model: "anthropic/claude-sonnet-4-5",
			},
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(calls[0].args).not.toContain("--thinking");
	});
});

describe("runReviewer — usage extraction", () => {
	it("returns the token + cost usage from the final assistant message", async () => {
		// Pi emits a `usage` block on every assistant
		// message_end event (cumulative). The terminal
		// `agent_end` event also carries the final cumulative
		// usage on the trailing assistant message. We use the
		// last assistant message_end's usage as the canonical
		// per-reviewer total: token counts (input, output,
		// cacheRead, cacheWrite, total) and dollar cost
		// (input, output, cacheRead, cacheWrite, total).
		const { runPi } = fakeRun({
			stdout: JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: {
						input: 1234,
						output: 567,
						cacheRead: 89,
						cacheWrite: 4321,
						totalTokens: 6211,
						cost: {
							input: 0.001,
							output: 0.002,
							cacheRead: 0.0001,
							cacheWrite: 0.05,
							total: 0.0531,
						},
					},
				},
			}),
		});
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(result.usage).toEqual({
			tokens: {
				input: 1234,
				output: 567,
				cacheRead: 89,
				cacheWrite: 4321,
				total: 6211,
			},
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0.0001,
				cacheWrite: 0.05,
				total: 0.0531,
			},
		});
	});

	it("sums usage across every assistant message_end in the stream", async () => {
		// A multi-step turn emits one message_end per LLM
		// round-trip, each carrying that request's own usage
		// (not a running total). The run's true usage is their
		// sum, so the dispatcher accumulates rather than
		// keeping only the last.
		const { runPi } = fakeRun({
			stdout: [
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "partial" }],
						usage: {
							input: 100,
							output: 50,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 150,
							cost: { total: 0.01 },
						},
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "final" }],
						usage: {
							input: 200,
							output: 100,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 300,
							cost: { total: 0.02 },
						},
					},
				}),
			].join("\n"),
		});
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(result.usage?.tokens.total).toBe(450);
		expect(result.usage?.cost.total).toBeCloseTo(0.03);
	});

	it("ignores usage on non-assistant messages", async () => {
		// User and tool_result message_end events also
		// include usage fields in some flows. Only the
		// assistant role's usage counts toward reviewer cost.
		const { runPi } = fakeRun({
			stdout: [
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 15,
							cost: { total: 0.001 },
						},
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "user",
						content: [{ type: "text", text: "trailing" }],
						usage: {
							input: 9999,
							output: 9999,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 19998,
							cost: { total: 99.99 },
						},
					},
				}),
			].join("\n"),
		});
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(result.usage?.tokens.total).toBe(15);
		expect(result.usage?.cost.total).toBeCloseTo(0.001);
	});

	it("leaves usage undefined when the stream contains no usage blocks", async () => {
		// Older pi versions or stubbed test runners may not
		// emit usage. The dispatcher treats it as optional
		// and lets callers fall back to "unknown".
		const { runPi } = fakeRun({
			stdout: assistantEvent("no usage in this stream"),
		});
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(result.usage).toBeUndefined();
	});

	it("tolerates partial cost objects (missing breakdown keys)", async () => {
		// Pi's cost block sometimes only ships `total` (e.g.
		// providers without per-channel pricing). Missing
		// breakdown keys default to zero so summing works.
		const { runPi } = fakeRun({
			stdout: JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					usage: {
						input: 10,
						output: 20,
						totalTokens: 30,
						cost: { total: 0.5 },
					},
				},
			}),
		});
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(result.usage).toEqual({
			tokens: {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				total: 30,
			},
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.5,
			},
		});
	});
});

describe("runReviewer — result extraction", () => {
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

		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			expectedVerificationStage: "council",
			requiresVerification: true,
			runPi,
		});

		expect(result.finalAssistantText).toContain("Stream verified");
		expect(result.verification?.ok).toBe(true);
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

		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			expectedVerificationStage: "council",
			requiresVerification: true,
			runPi,
		});

		expect(result.finalAssistantText).toContain(bigDiscussion);
		expect(result.verification?.ok).toBe(true);
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

		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			requiresVerification: true,
			runPi,
		});

		expect(result.finalAssistantText).toContain("Verified subject");
		expect(result.finalAssistantText).not.toContain("not parseable");
		expect(result.finalAssistantText).not.toContain("```json");
		expect(result.verification?.ok).toBe(true);
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

		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			expectedVerificationStage: "council",
			requiresVerification: true,
			runPi,
		});

		expect(result.finalAssistantText).toBe("");
		expect(result.verification?.ok).toBe(false);
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

		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			expectedVerificationStage: "council",
			requiresVerification: true,
			runPi,
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

		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			expectedVerificationStage: "council",
			requiresVerification: true,
			runPi,
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

		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			expectedVerificationStage: "council",
			requiresVerification: true,
			runPi,
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

		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			requiresVerification: true,
			runPi,
		});

		expect(result.finalAssistantText).toBe("");
		expect(result.warnings.some((w) => w.includes("ignored"))).toBe(true);
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
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
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
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
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
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(result.finalAssistantText).toBe("first\nsecond");
	});

	it("emits a warning for malformed JSON event lines but doesn't abort", async () => {
		// One garbled line out of thousands shouldn't
		// strand the whole reviewer output. We log the
		// warning and continue.
		const { runPi } = fakeRun({
			stdout: ["not json at all", assistantEvent("ok")].join("\n"),
		});
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
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

		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});

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

		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			extraExtensions: ["/abs/path/to/pr-workflow-verify/index.ts"],
			expectedVerificationStage: "council",
			requiresVerification: true,
			runPi,
		});

		expect(result.finalAssistantText).toContain("Verified despite exit");
		expect(result.warnings.some((w) => /exit 1|non-zero/i.test(w))).toBe(true);
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
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(result.exitCode).toBe(1);
		expect(result.finalAssistantText).toBe("partial");
		expect(result.warnings.some((w) => /exit 1|non-zero/i.test(w))).toBe(true);
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
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
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
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(result.warnings.some((w) => w.startsWith("Pi stderr:"))).toBe(false);
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
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(result.warnings.some((w) => w.startsWith("Pi stderr:"))).toBe(false);
		expect(result.stderr).toContain("deprecation notice");
	});

	it("returns reviewerId from the input config so callers can correlate results", async () => {
		// Multiple reviewers run concurrently. The id on
		// the result is what ties findings back to the
		// reviewer that produced them.
		const { runPi } = fakeRun({
			stdout: assistantEvent("{}"),
		});
		const result = await runReviewer({
			reviewer: { ...REVIEWER, id: "council-skeptic" },
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(result.reviewerId).toBe("council-skeptic");
	});
});

describe("runReviewer — stale runtime detection", () => {
	it("refuses to spawn when the captured pi binary path is gone", async () => {
		// Pi was updated (nix gc, brew upgrade) mid-session.
		// The currently-running binary path no longer exists
		// on disk, so any subagent we spawn will hit ENOENT
		// loading parent-derived extension paths. Better to
		// short-circuit with a clear advisory than to burn a
		// retry-loop cycle producing the same crash.
		const { runPi, calls } = fakeRun({ stdout: assistantEvent("{}") });
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
			checkRuntime: () => ({
				path: "/nix/store/old-pi/bin/pi",
				message:
					"Pi runtime stale: the running pi binary at " +
					"`/nix/store/old-pi/bin/pi` no longer exists. Restart pi.",
			}),
		});
		expect(calls).toHaveLength(0);
		expect(result.exitCode).toBe(127);
		expect(result.finalAssistantText).toBe("");
		expect(result.warnings.some((w) => w.startsWith("Pi runtime stale:"))).toBe(
			true,
		);
		expect(result.stderr).toContain("/nix/store/old-pi/bin/pi");
	});

	it("detects the stale-install ENOENT shape in spawned stderr and adds a clear warning", async () => {
		// The pre-dispatch probe can miss paths it doesn't
		// know about (extension resolution, native binaries).
		// As a defensive layer, match the canonical ENOENT
		// shape post-spawn so the dispatcher still surfaces
		// a restart advisory instead of a generic retry hint.
		const { runPi } = fakeRun({
			stdout: "",
			stderr: [
				"node:fs:440",
				"Error: ENOENT: no such file or directory, open '/Users/x/.pi/pkg/pi-0.75.3/package.json'",
			].join("\n"),
			exitCode: 1,
		});
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		const stale = result.warnings.find((w) =>
			w.startsWith("Pi runtime stale:"),
		);
		expect(stale).toBeDefined();
		expect(stale).toContain("/Users/x/.pi/pkg/pi-0.75.3");
		expect(stale).toMatch(/restart pi/i);
	});

	it("leaves an unrelated ENOENT stderr untouched (no false positive)", async () => {
		const { runPi } = fakeRun({
			stdout: "",
			stderr:
				"Error: ENOENT: no such file or directory, open '/tmp/missing.json'",
			exitCode: 1,
		});
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(result.warnings.some((w) => w.startsWith("Pi runtime stale:"))).toBe(
			false,
		);
	});
});

describe("runReviewer — timeout validation", () => {
	// Per-call timeout overrides are public library input.
	// The tool schema enforces `minimum: 1000` at the fleet
	// boundary, but pr-workflow and any future library
	// consumer land in `runReviewer` directly. Validation
	// at the library boundary keeps the contract consistent
	// across entry points and turns nonsense values into
	// loud, early errors instead of supervisor confusion.

	it("rejects timeoutMs below the floor with a clear error", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		await expect(
			runReviewer({
				reviewer: REVIEWER,
				prompt: "p",
				cwd: "/tmp/wt",
				runPi,
				timeoutMs: 500,
			}),
		).rejects.toThrow(/Invalid timeoutMs.*below the 1000 ms floor/);
	});

	it("rejects negative idleTimeoutMs with a clear error", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		await expect(
			runReviewer({
				reviewer: REVIEWER,
				prompt: "p",
				cwd: "/tmp/wt",
				runPi,
				idleTimeoutMs: -1,
			}),
		).rejects.toThrow(/Invalid idleTimeoutMs/);
	});

	it("rejects non-finite timeout values", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		await expect(
			runReviewer({
				reviewer: REVIEWER,
				prompt: "p",
				cwd: "/tmp/wt",
				runPi,
				timeoutMs: Number.POSITIVE_INFINITY,
			}),
		).rejects.toThrow(/expected a finite integer/);
	});

	it("rejects non-integer timeout values", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		await expect(
			runReviewer({
				reviewer: REVIEWER,
				prompt: "p",
				cwd: "/tmp/wt",
				runPi,
				timeoutMs: 1500.5,
			}),
		).rejects.toThrow(/expected a finite integer/);
	});

	it("rejects values above the 8-hour ceiling", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		await expect(
			runReviewer({
				reviewer: REVIEWER,
				prompt: "p",
				cwd: "/tmp/wt",
				runPi,
				timeoutMs: 9 * 60 * 60 * 1000,
			}),
		).rejects.toThrow(/exceeds the.*ceiling/);
	});

	it("accepts a 6-hour timeout (within the 8-hour ceiling)", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
			timeoutMs: 6 * 60 * 60 * 1000,
			idleTimeoutMs: 6 * 60 * 60 * 1000,
		});
		expect(result.finalAssistantText).toBe("ok");
	});

	it("rejects idleTimeoutMs greater than timeoutMs", async () => {
		// The wall clock would fire first regardless of how
		// patient the idle ceiling is. Catching the
		// inconsistency at the boundary surfaces the bug a
		// reader would only notice by watching their soak
		// run die at the 20-minute mark.
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		await expect(
			runReviewer({
				reviewer: REVIEWER,
				prompt: "p",
				cwd: "/tmp/wt",
				runPi,
				timeoutMs: 5 * 60 * 1000,
				idleTimeoutMs: 10 * 60 * 1000,
			}),
		).rejects.toThrow(
			/idleTimeoutMs.*exceeds timeoutMs.*wall clock would fire first/,
		);
	});

	it("accepts valid timeout pairs within the bounds", async () => {
		// Sanity check: legitimate long-running overrides
		// pass validation untouched. The runner sees the
		// values; the library doesn't mutate them.
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
			timeoutMs: 45 * 60 * 1000,
			idleTimeoutMs: 15 * 60 * 1000,
		});
		expect(result.exitCode).toBe(0);
	});

	it("accepts undefined overrides (runner default applies)", async () => {
		const { runPi } = fakeRun({ stdout: assistantEvent("ok") });
		const result = await runReviewer({
			reviewer: REVIEWER,
			prompt: "p",
			cwd: "/tmp/wt",
			runPi,
		});
		expect(result.exitCode).toBe(0);
	});
});
