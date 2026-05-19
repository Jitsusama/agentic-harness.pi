import { describe, expect, it, vi } from "vitest";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import {
	buildFixPrompt,
	parseFixOutput,
	runFix,
} from "../../../extensions/pr-workflow/fix.js";
import type { RunPi } from "../../../extensions/pr-workflow/reviewer.js";

/**
 * Fix subagent.
 *
 * One subagent per queued finding: built prompt instructs
 * the model to read code in the worktree, apply the fix
 * via real edits and return a structured summary. The
 * subprocess boundary (`RunPi`) is the same one reviewers
 * use, so production wraps `node:child_process.spawn` and
 * tests substitute a stub.
 */

function lineFinding(overrides: Partial<Finding> = {}): Finding {
	return {
		id: 17,
		location: {
			kind: "line",
			file: "lib/handlers.ts",
			start: 200,
			end: 202,
			side: "new",
		},
		label: "issue",
		decorations: [],
		subject: "Trailing comma trips strict-mode parser",
		discussion: "Line 201 leaves a dangling comma in the args list; remove it.",
		category: "file",
		origin: { kind: "judge", runId: "j-1", judgeReviewerId: "j" },
		state: "draft",
		...overrides,
	};
}

describe("buildFixPrompt", () => {
	it("instructs the subagent to apply changes via real edits, not describe them", () => {
		const prompt = buildFixPrompt({
			finding: lineFinding(),
			worktreePath: "/tmp/w/17",
			prTitle: "Make handlers strict",
		});
		// The subagent's tools include edit/write; the
		// prompt has to tell it to USE them rather than
		// just narrate what it would do.
		expect(prompt).toMatch(/apply|edit|write/i);
		// Explicit "don't just describe" framing.
		expect(prompt).toMatch(/do not (propose|describe|suggest)|make them/i);
	});

	it("carries the finding's location, subject and discussion verbatim", () => {
		// The model can't guess context the prompt
		// doesn't carry; everything it needs to act
		// must be in the prompt.
		const prompt = buildFixPrompt({
			finding: lineFinding(),
			worktreePath: "/tmp/w/17",
		});
		expect(prompt).toContain("lib/handlers.ts");
		expect(prompt).toContain("200");
		expect(prompt).toContain("202");
		expect(prompt).toContain("Trailing comma trips strict-mode parser");
		expect(prompt).toContain("dangling comma");
	});

	it("specifies the JSON schema the subagent must emit", () => {
		// runFix parses the subagent's last JSON object,
		// so the prompt must pin the schema or output
		// drifts.
		const prompt = buildFixPrompt({
			finding: lineFinding(),
			worktreePath: "/tmp/w/17",
		});
		expect(prompt).toMatch(/"findingId"/);
		expect(prompt).toMatch(/"modifiedFiles"/);
		expect(prompt).toMatch(/"summary"/);
	});

	it("shows `modifiedFiles` in the schema as an array, not a single value", () => {
		// Without explicit array framing in the schema,
		// models sometimes emit a single string. Pin the
		// `[...]` form.
		const prompt = buildFixPrompt({
			finding: lineFinding(),
			worktreePath: "/tmp/w/17",
		});
		expect(prompt).toMatch(/"modifiedFiles":\s*\[/);
	});

	it("forwards optional user instructions to the subagent", () => {
		const prompt = buildFixPrompt({
			finding: lineFinding(),
			worktreePath: "/tmp/w/17",
			userInstructions: "Match the existing helper-fn style.",
		});
		expect(prompt).toContain("Match the existing helper-fn style.");
	});
});

describe("parseFixOutput", () => {
	it("extracts the last JSON object — subagents may narrate before emitting", () => {
		const output = `
Looking at handlers.ts...
I'll remove the trailing comma on line 201.
{"findingId": 17, "summary": "removed trailing comma", "modifiedFiles": ["lib/handlers.ts"]}
`;
		const result = parseFixOutput(output);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.findingId).toBe(17);
			expect(result.value.summary).toBe("removed trailing comma");
			expect(result.value.modifiedFiles).toEqual(["lib/handlers.ts"]);
		}
	});

	it("returns an error when the JSON is missing", () => {
		const result = parseFixOutput("I thought about the fix and gave up.");
		expect(result.ok).toBe(false);
	});

	it("returns an error when required fields are absent", () => {
		const result = parseFixOutput('{"findingId": 17}');
		expect(result.ok).toBe(false);
	});

	it("rejects when only `summary` is missing", () => {
		const result = parseFixOutput(
			'{"findingId": 17, "modifiedFiles": ["lib/x.ts"]}',
		);
		expect(result.ok).toBe(false);
	});

	it("rejects when only `modifiedFiles` is missing", () => {
		const result = parseFixOutput('{"findingId": 17, "summary": "x"}');
		expect(result.ok).toBe(false);
	});

	it("accepts an empty modifiedFiles list — a no-op fix is still valid output", () => {
		const result = parseFixOutput(
			'{"findingId": 17, "summary": "already correct in HEAD", "modifiedFiles": []}',
		);
		expect(result.ok).toBe(true);
	});

	it("rejects modifiedFiles that isn't an array of strings", () => {
		const result = parseFixOutput(
			'{"findingId": 17, "summary": "x", "modifiedFiles": "lib/x.ts"}',
		);
		expect(result.ok).toBe(false);
	});
});

describe("runFix", () => {
	it("dispatches one subagent per finding through the RunPi boundary", async () => {
		const runPi: RunPi = vi.fn(async () => ({
			stdout: JSON.stringify({
				findingId: 17,
				summary: "fixed",
				modifiedFiles: ["lib/x.ts"],
			}),
			stderr: "",
			exitCode: 0,
		}));
		const result = await runFix({
			runPi,
			model: "anthropic:claude-sonnet-4.5",
			tools: ["read", "edit", "write", "grep"],
			finding: lineFinding(),
			worktreePath: "/tmp/w/17",
		});
		expect(runPi).toHaveBeenCalledTimes(1);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.output.modifiedFiles).toEqual(["lib/x.ts"]);
		}
	});

	it("passes the worktree path as the subagent's cwd", async () => {
		const runPi: RunPi = vi.fn(async () => ({
			stdout: JSON.stringify({
				findingId: 17,
				summary: "fixed",
				modifiedFiles: [],
			}),
			stderr: "",
			exitCode: 0,
		}));
		await runFix({
			runPi,
			model: "anthropic:claude-sonnet-4.5",
			tools: ["read", "edit"],
			finding: lineFinding(),
			worktreePath: "/tmp/w/17",
		});
		const call = (runPi as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.cwd).toBe("/tmp/w/17");
	});

	it("returns the parse error when the subagent emits no JSON", async () => {
		const runPi: RunPi = vi.fn(async () => ({
			stdout: "I am confused.",
			stderr: "",
			exitCode: 0,
		}));
		const result = await runFix({
			runPi,
			model: "x",
			tools: ["read"],
			finding: lineFinding(),
			worktreePath: "/tmp/w/17",
		});
		expect(result.ok).toBe(false);
	});

	it("surfaces non-zero exit codes as errors", async () => {
		const runPi: RunPi = vi.fn(async () => ({
			stdout: "",
			stderr: "model rate-limited",
			exitCode: 1,
		}));
		const result = await runFix({
			runPi,
			model: "x",
			tools: ["read"],
			finding: lineFinding(),
			worktreePath: "/tmp/w/17",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/rate-limited|exit|1/i);
		}
	});

	it("forwards the configured tool set to the subagent via --tools", async () => {
		const runPi: RunPi = vi.fn(async () => ({
			stdout: JSON.stringify({
				findingId: 17,
				summary: "fixed",
				modifiedFiles: [],
			}),
			stderr: "",
			exitCode: 0,
		}));
		await runFix({
			runPi,
			model: "x",
			tools: ["read", "edit", "write", "bash"],
			finding: lineFinding(),
			worktreePath: "/tmp/w/17",
		});
		const args = (runPi as ReturnType<typeof vi.fn>).mock.calls[0][0].args;
		const toolsIdx = args.indexOf("--tools");
		expect(toolsIdx).toBeGreaterThanOrEqual(0);
		expect(args[toolsIdx + 1]).toBe("read,edit,write,bash");
	});

	it("forwards the configured model via --model", async () => {
		const runPi: RunPi = vi.fn(async () => ({
			stdout: JSON.stringify({
				findingId: 17,
				summary: "fixed",
				modifiedFiles: [],
			}),
			stderr: "",
			exitCode: 0,
		}));
		await runFix({
			runPi,
			model: "anthropic:claude-opus-4",
			tools: ["read"],
			finding: lineFinding(),
			worktreePath: "/tmp/w/17",
		});
		const args = (runPi as ReturnType<typeof vi.fn>).mock.calls[0][0].args;
		const modelIdx = args.indexOf("--model");
		expect(args[modelIdx + 1]).toBe("anthropic:claude-opus-4");
	});

	it("rejects a parsed output whose findingId doesn't match the requested one", async () => {
		// A subagent that returns the wrong finding id
		// has lost the plot; refuse rather than apply
		// blindly.
		const runPi: RunPi = vi.fn(async () => ({
			stdout: JSON.stringify({
				findingId: 999,
				summary: "fixed something else",
				modifiedFiles: ["wrong.ts"],
			}),
			stderr: "",
			exitCode: 0,
		}));
		const result = await runFix({
			runPi,
			model: "x",
			tools: ["read"],
			finding: lineFinding(),
			worktreePath: "/tmp/w/17",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/finding.*id|mismatch/i);
		}
	});
});
