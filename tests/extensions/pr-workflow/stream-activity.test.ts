/**
 * Tests for the pi-stream → activity-string translator.
 *
 * Council reviewers emit pi `--mode json` events. The
 * translator picks out tool calls and returns a short
 * line for the UI. The council progress reporter forwards
 * the line via `reviewerActivity`.
 *
 * These tests work in terms of "what activity string
 * does this event produce", not the underlying tool
 * names or arg shapes.
 */

import { describe, expect, it } from "vitest";
import { summarizeStreamActivity } from "../../../extensions/pr-workflow/council-progress.js";

describe("summarizeStreamActivity", () => {
	it("returns null for non-object events", () => {
		expect(summarizeStreamActivity(null)).toBeNull();
		expect(summarizeStreamActivity("text")).toBeNull();
	});

	it("returns null for events that aren't tool lifecycle events", () => {
		expect(
			summarizeStreamActivity({ type: "message_end", message: {} }),
		).toBeNull();
		expect(summarizeStreamActivity({ type: "agent_start" })).toBeNull();
	});

	it("renders read with the file path", () => {
		expect(
			summarizeStreamActivity({
				type: "tool_execution_start",
				toolName: "read",
				args: { path: "extensions/pr-workflow/index.ts" },
			}),
		).toBe("reading extensions/pr-workflow/index.ts");
	});

	it("falls back to `file` arg when read uses the alternate field name", () => {
		expect(
			summarizeStreamActivity({
				type: "tool_execution_start",
				toolName: "Read",
				args: { file: "task.go" },
			}),
		).toBe("reading task.go");
	});

	it("renders grep with the pattern", () => {
		expect(
			summarizeStreamActivity({
				type: "tool_execution_start",
				toolName: "grep",
				args: { pattern: "Save" },
			}),
		).toBe("grep Save");
	});

	it("renders glob with the pattern", () => {
		expect(
			summarizeStreamActivity({
				type: "tool_execution_start",
				toolName: "glob",
				args: { pattern: "**/*.go" },
			}),
		).toBe("glob **/*.go");
	});

	it("renders bash with the command", () => {
		expect(
			summarizeStreamActivity({
				type: "tool_execution_start",
				toolName: "bash",
				args: { command: "go test ./..." },
			}),
		).toBe("bash go test ./...");
	});

	it("falls back to `running <toolName>` for unknown tools", () => {
		expect(
			summarizeStreamActivity({
				type: "tool_execution_start",
				toolName: "mystery_tool",
				args: {},
			}),
		).toBe("running mystery_tool");
	});

	it("truncates long arguments with an ellipsis", () => {
		const longPath = "a".repeat(80);
		const out = summarizeStreamActivity({
			type: "tool_execution_start",
			toolName: "read",
			args: { path: longPath },
		});
		expect(out?.startsWith("reading ")).toBe(true);
		expect(out?.endsWith("…")).toBe(true);
		// 40 chars + the prefix; total below 60.
		expect((out ?? "").length).toBeLessThanOrEqual(60);
	});

	it("emits the verify-output hint when the reviewer calls verify_output", () => {
		expect(
			summarizeStreamActivity({
				type: "tool_execution_start",
				toolName: "verify_output",
				args: { json: "..." },
			}),
		).toBe("verifying output");
	});

	it("shows that a tool finished before the model-thinking gap", () => {
		expect(
			summarizeStreamActivity({
				type: "tool_execution_end",
				toolName: "read",
				result: {},
				isError: false,
			}),
		).toBe("finished reading; waiting for model");
	});

	it("surfaces failed tool completion", () => {
		expect(
			summarizeStreamActivity({
				type: "tool_execution_end",
				toolName: "verify_output",
				result: {},
				isError: true,
			}),
		).toBe("verifying output failed");
	});
});
