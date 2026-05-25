import { describe, expect, it } from "vitest";
import {
	type CouncilReviewer,
	type ReviewerVerification,
	type RunPi,
	runReviewer,
} from "../../../extensions/pr-workflow/reviewer.js";

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
	verification?: ReviewerVerification;
}): { runPi: RunPi; calls: Array<{ args: string[]; cwd: string }> } {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const runPi: RunPi = async (opts) => {
		calls.push({ args: opts.args, cwd: opts.cwd });
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.exitCode ?? 0,
			...(result.verification ? { verification: result.verification } : {}),
		};
	};
	return { runPi, calls };
}

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

	it("passes the prompt as the last positional argument", async () => {
		// Pi reads the task from the final positional.
		// Keeping it last avoids accidental flag parsing
		// of prompt content.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{"findings": []}`),
		});
		await runReviewer({
			reviewer: REVIEWER,
			prompt: "Review the diff at hand",
			cwd: "/tmp/wt",
			runPi,
		});
		const args = calls[0].args;
		expect(args[args.length - 1]).toBe("Review the diff at hand");
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

	it("prefers the last assistant message_end's usage when the stream has many", async () => {
		// During a multi-step turn pi emits partial usage
		// updates and a final one. The reviewer dispatcher
		// should adopt the LAST cumulative figure, not the
		// first.
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
		expect(result.usage?.tokens.total).toBe(300);
		expect(result.usage?.cost.total).toBeCloseTo(0.02);
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
			runPi,
		});

		expect(result.finalAssistantText).toBe("");
		expect(result.warnings.join("\n")).toContain(
			"returned ok: true but the verified payload was not captured",
		);
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
