/**
 * The pi command line `runReviewer` composes for a reviewer: its model,
 * tools, extensions, thinking level, prompt file and working directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type RunPi, runReviewer } from "../../../lib/subagent/subagent.ts";
import { at } from "../../support/at.ts";
import { assistantEvent, fakeRun, REVIEWER, review } from "./fake-runs.ts";

describe("runReviewer: argument composition", () => {
	it("passes the reviewer model via --model and tools via --tools (csv)", async () => {
		// pi --mode json --no-session -p --model X --tools T1,T2 PROMPT
		// is the established shape from the subagent
		// example. Tools join with commas so a single
		// --tools flag carries the whole palette.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{"findings": []}`),
		});
		await review(runPi);
		expect(calls).toHaveLength(1);
		const args = at(calls, 0).args;
		expect(args).toContain("--mode");
		expect(args[args.indexOf("--mode") + 1]).toBe("json");
		expect(args).toContain("--no-session");
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe(
			"anthropic/claude-sonnet-4-5",
		);
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe(
			"read,grep,glob,ls,bash,verify_output,record_finding",
		);
	});

	it("appends verify_output to a tools palette that doesn't already list it", async () => {
		// Pi's --tools flag is an allowlist that applies to
		// extension tools too. The reviewer prompt instructs
		// the subagent to call verify_output, so the
		// dispatcher must guarantee it's in the palette
		// even when the caller forgets.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent("{}"),
		});
		await review(runPi, {
			reviewer: { id: "narrow", tools: ["read"] },
		});
		const args = at(calls, 0).args;
		// record_finding rides along for the same reason: a palette
		// that omits it silently denies the reviewer the one tool that
		// makes an interrupted review worth anything, while its
		// contract goes on telling it to call that tool.
		expect(args[args.indexOf("--tools") + 1]).toBe(
			"read,verify_output,record_finding",
		);
	});

	it("does not duplicate verify_output when the palette already includes it", async () => {
		// Defensive: if a caller does include verify_output
		// explicitly, the dispatcher should leave it where
		// it sits and not append a second copy.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent("{}"),
		});
		await review(runPi, {
			reviewer: {
				id: "explicit",
				tools: ["read", "verify_output", "grep"],
			},
		});
		const args = at(calls, 0).args;
		expect(args[args.indexOf("--tools") + 1]).toBe(
			"read,verify_output,grep,record_finding",
		);
	});

	it("omits --tools entirely when the palette is empty so pi falls back to its default", async () => {
		// Empty palette means "inherit pi's defaults" (all
		// loaded tools). In that mode pi allows verify_output
		// because it's part of the loaded pr-workflow-verify
		// extension, so we don't need to force a --tools
		// flag just to keep the verify path open.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent("{}"),
		});
		await review(runPi, {
			reviewer: { id: "defaults" },
		});
		expect(at(calls, 0).args).not.toContain("--tools");
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
		expect(at(calls, 0).cwd).toBe("/tmp/pi-state/worktrees/o-r/sha");
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
		expect(promptArg).toMatch(/^@/);
		expect(promptArg).not.toBe(prompt);
		expect(fileContent).toBe(prompt);
		// The temp file is cleaned up once the run resolves.
		const promptFile = promptArg?.slice(1) ?? "";
		expect(existsSync(promptFile), `${promptFile} is gone`).toBe(false);
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
		await review(runPi, {
			extraExtensions: [
				"/abs/path/to/pr-workflow-verify/index.ts",
				"/abs/path/to/another-extension/index.ts",
			],
		});
		const args = at(calls, 0).args;
		const extensionFlagPositions: number[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--extension") extensionFlagPositions.push(i);
		}
		// The caller's two, then the budget pack every subagent loads.
		expect(extensionFlagPositions).toHaveLength(3);
		expect(args[at(extensionFlagPositions, 0) + 1]).toBe(
			"/abs/path/to/pr-workflow-verify/index.ts",
		);
		expect(args[at(extensionFlagPositions, 1) + 1]).toBe(
			"/abs/path/to/another-extension/index.ts",
		);
	});

	it("loads only the budget pack when no extraExtensions are supplied", async () => {
		// Older callers and the default path don't pass
		// extensions through; the one pack every subagent
		// loads is the one that says its budget in its log.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{"findings": []}`),
		});
		await review(runPi);
		const args = at(calls, 0).args;
		const extensions = args.filter(
			(_, i) => i > 0 && args[i - 1] === "--extension",
		);
		expect(extensions).toEqual([
			expect.stringMatching(/packs\/budget-entry\/index\.ts$/),
		]);
	});

	it("omits --model and --tools when the reviewer config doesn't specify them", async () => {
		// Fallback to pi's defaults (whatever the user has
		// configured in their session). The dispatcher
		// only forces flags the reviewer explicitly opts
		// into.
		const { runPi, calls } = fakeRun({
			stdout: assistantEvent(`{"findings": []}`),
		});
		await review(runPi, {
			reviewer: { id: "bare" },
		});
		const args = at(calls, 0).args;
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
		await review(runPi, {
			reviewer: {
				id: "deep",
				model: "anthropic/claude-opus-4-7",
				thinkingLevel: "high",
			},
		});
		const args = at(calls, 0).args;
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
		await review(runPi, {
			reviewer: {
				id: "default",
				model: "anthropic/claude-sonnet-4-5",
			},
		});
		expect(at(calls, 0).args).not.toContain("--thinking");
	});
});
