import { describe, expect, it } from "vitest";
import {
	type CouncilReviewer,
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
	model: "anthropic:claude-sonnet-4.5",
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
}): { runPi: RunPi; calls: Array<{ args: string[]; cwd: string }> } {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const runPi: RunPi = async (opts) => {
		calls.push({ args: opts.args, cwd: opts.cwd });
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.exitCode ?? 0,
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
			"anthropic:claude-sonnet-4.5",
		);
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,glob,ls,bash");
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
	});
});

describe("runReviewer — result extraction", () => {
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
