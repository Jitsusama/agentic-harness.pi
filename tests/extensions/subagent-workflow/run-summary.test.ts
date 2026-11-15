/**
 * What a fleet says when it is done: `formatFleetSummary`'s lines, the
 * artifacts `locateArtifacts` finds, and the stderr tail
 * `summarizeStderrTail` keeps.
 */

import { describe, expect, it } from "vitest";
import {
	formatFleetSummary,
	locateArtifacts,
	summarizeStderrTail,
} from "../../../extensions/subagent-workflow/run.ts";
import { at } from "../../support/at.ts";
import { makeUsage } from "./fleet-usage.ts";

describe("formatFleetSummary", () => {
	it("includes counts and usage in the header line", () => {
		const summary = formatFleetSummary({
			runId: "fleet-abc",
			results: [
				{ id: "a", finalAssistantText: "", warnings: [], state: "complete" },
				{ id: "b", finalAssistantText: "", warnings: [], state: "failed" },
				{ id: "c", finalAssistantText: "", warnings: [], state: "cancelled" },
			],
			totalUsage: makeUsage(1000, 250),
			warnings: [],
		});
		const header = summary.split("\n")[0];
		expect(header).toContain("fleet-abc");
		expect(header).toContain("1/3 complete");
		expect(header).toContain("1 failed");
		expect(header).toContain("1 cancelled");
		expect(header).toContain("1,250 tokens");
	});

	it("renders a per-failure line with the failure reason", () => {
		// The header tells the user how many failed; the
		// per-failure lines tell them WHY. Each failure shows
		// its id and the human-readable error so the user
		// doesn't have to inspect the details payload to
		// understand the run.
		const summary = formatFleetSummary({
			runId: "fleet-xyz",
			results: [
				{ id: "a", finalAssistantText: "", warnings: [], state: "complete" },
				{
					id: "b",
					finalAssistantText: "",
					warnings: [],
					state: "failed",
					error: "pi exited with code 1: No API key found for anthropic.",
				},
				{
					id: "c",
					finalAssistantText: "",
					warnings: [],
					state: "failed",
					error: "pi exited with code 124: timeout",
				},
			],
			warnings: [],
		});
		const lines = summary.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("b");
		expect(lines[1]).toContain("No API key found");
		expect(lines[2]).toContain("c");
		expect(lines[2]).toContain("timeout");
	});

	it("falls back to a generic reason when a failure has no error string", () => {
		// `error` is documented as optional. The summary still
		// names the subagent and labels the line as a failure;
		// it just can't tell the user why.
		const summary = formatFleetSummary({
			runId: "fleet-q",
			results: [
				{ id: "silent", finalAssistantText: "", warnings: [], state: "failed" },
			],
			warnings: [],
		});
		const lines = summary.split("\n");
		expect(lines[1]).toContain("silent");
		expect(lines[1]).toMatch(/unknown failure/);
	});

	it("surfaces the run dir and per-subagent result paths when located", () => {
		// Without these pointers the summary reads as the whole
		// result; in fact each subagent's full output is on disk.
		const summary = formatFleetSummary({
			runId: "fleet-loc",
			runDir: "/state/runs/fleet-loc",
			results: [
				{
					id: "alpha",
					finalAssistantText: "long output",
					warnings: [],
					state: "complete",
					resultPath: "/state/runs/fleet-loc/reviewers/alpha/result.json",
				},
			],
			warnings: [],
		});
		expect(summary).toContain("full output: /state/runs/fleet-loc");
		expect(summary).toContain(
			"alpha → /state/runs/fleet-loc/reviewers/alpha/result.json",
		);
	});

	it("omits the location block when no run dir is resolved", () => {
		// Backward compatible: results without runDir (older
		// callers, tests) render exactly as before.
		const summary = formatFleetSummary({
			runId: "fleet-bare",
			results: [
				{ id: "a", finalAssistantText: "", warnings: [], state: "complete" },
			],
			warnings: [],
		});
		expect(summary.split("\n")).toHaveLength(1);
		expect(summary).not.toContain("full output");
	});
});

describe("locateArtifacts", () => {
	const base = {
		runId: "fleet-xyz",
		warnings: [],
		results: [
			{
				id: "alpha",
				finalAssistantText: "a",
				warnings: [],
				state: "complete" as const,
			},
			{
				id: "beta",
				finalAssistantText: "b",
				warnings: [],
				state: "complete" as const,
			},
		],
	};

	it("derives the run dir and each subagent's result path from the store", () => {
		const located = locateArtifacts("/state", base);
		// The run dir hangs off the state dir, keyed by run id.
		expect(located.runDir).toContain("fleet-xyz");
		expect(located.runDir).toContain("/state");
		// Each subagent gets its own result.json under reviewers/<id>.
		expect(located.results[0]?.resultPath).toContain("alpha");
		expect(located.results[0]?.resultPath).toContain("result.json");
		expect(located.results[1]?.resultPath).toContain("beta");
		// The result.json lives beneath the run dir.
		const runDir = located.runDir ?? "";
		expect(located.results[0]?.resultPath?.slice(0, runDir.length)).toBe(
			runDir,
		);
	});

	it("preserves the original fields and per-subagent identity", () => {
		const located = locateArtifacts("/state", base);
		expect(located.runId).toBe("fleet-xyz");
		expect(located.results).toHaveLength(2);
		expect(located.results[0]?.id).toBe("alpha");
		expect(located.results[0]?.finalAssistantText).toBe("a");
		// Distinct subagents get distinct result paths.
		expect(at(located.results, 0).resultPath).not.toBe(
			at(located.results, 1).resultPath,
		);
	});
});

describe("summarizeStderrTail", () => {
	it("returns the last few non-blank lines joined with separators", () => {
		// A multi-line stderr should boil down to the last
		// non-blank lines, joined for inline display. Blank
		// lines (common in pi's error output) are dropped so
		// they don't waste the character budget.
		const stderr = "line one\n\nline two\n\nline three\nline four\nline five\n";
		const tail = summarizeStderrTail(stderr);
		expect(tail).toContain("line five");
		expect(tail).toContain("line four");
		expect(tail).toContain("line three");
		expect(tail).not.toContain("line one");
	});

	it("returns an empty string for empty input", () => {
		expect(summarizeStderrTail("")).toBe("");
		expect(summarizeStderrTail("\n\n\n")).toBe("");
	});

	it("truncates very long tails so they fit inline", () => {
		// The cap is there to keep the summary line readable
		// in the TUI; the verbatim text is still on the
		// result for callers that want the rest.
		const long = "x".repeat(1000);
		const tail = summarizeStderrTail(long);
		expect(tail.length).toBeLessThanOrEqual(240);
		expect(tail).toMatch(/\.\.\.$/);
	});
});
