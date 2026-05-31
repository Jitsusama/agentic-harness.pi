import { describe, expect, it, vi } from "vitest";
import { FleetCancellationRegistry } from "../../../extensions/subagent-workflow/cancellation";
import type {
	FleetProgress,
	FleetProgressEntry,
} from "../../../extensions/subagent-workflow/progress";
import {
	buildAssignment,
	dispatchFleet,
	type FleetAssignment,
	formatFleetSummary,
	summarizeStderrTail,
} from "../../../extensions/subagent-workflow/run";
import type {
	RunPi,
	RunPiResult,
	SubagentUsage,
} from "../../../lib/subagent/subagent";

// The orchestrator threads the engine, the cancellation
// registry and the progress observer together. These
// tests use fake runners + array-backed observers so the
// integration is exercised without spawning real pi
// processes or rendering a TUI.

function makeUsage(input: number, output: number): SubagentUsage {
	return {
		tokens: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			total: input + output,
		},
		cost: {
			input: input * 0.001,
			output: output * 0.001,
			cacheRead: 0,
			cacheWrite: 0,
			total: (input + output) * 0.001,
		},
	};
}

function recordingProgress(): {
	progress: FleetProgress;
	events: string[];
	starts: FleetProgressEntry[][];
} {
	const events: string[] = [];
	const starts: FleetProgressEntry[][] = [];
	const progress: FleetProgress = {
		start(entries) {
			starts.push(entries.map((e) => ({ ...e })));
		},
		subagentStarted(id) {
			events.push(`start:${id}`);
		},
		subagentActivity(id, activity) {
			events.push(`activity:${id}:${activity}`);
		},
		subagentCompleted(id) {
			events.push(`complete:${id}`);
		},
		subagentCancelled(id) {
			events.push(`cancelled:${id}`);
		},
		subagentFailed(id, error) {
			events.push(`failed:${id}:${error}`);
		},
		finish() {
			events.push("finish");
		},
	};
	return { progress, events, starts };
}

function assignment(
	id: string,
	runPiReply?: Partial<RunPiResult>,
): {
	assignment: FleetAssignment;
	runPi: RunPi;
} {
	const runPi: RunPi = async () => ({
		exitCode: 0,
		lines: [],
		finalAssistantText: `${id} report`,
		stderr: "",
		warnings: [],
		...runPiReply,
	});
	return {
		assignment: {
			spec: { id },
			job: { userPrompt: `do work as ${id}`, cwd: "/tmp" },
		},
		runPi,
	};
}

describe("dispatchFleet", () => {
	it("returns per-subagent results in assignment order", async () => {
		// Order preservation lets the host agent correlate
		// jobs to results by index without round-tripping
		// through subagent ids.
		const cancellations = new FleetCancellationRegistry();
		const runPi: RunPi = async ({ reviewerId }) => ({
			exitCode: 0,
			lines: [],
			finalAssistantText: `${reviewerId} done`,
			stderr: "",
			warnings: [],
		});
		const result = await dispatchFleet({
			runId: "r1",
			assignments: [
				assignment("first").assignment,
				assignment("second").assignment,
				assignment("third").assignment,
			],
			runPi,
			cancellations,
		});
		expect(result.results.map((r) => r.id)).toEqual([
			"first",
			"second",
			"third",
		]);
		expect(result.results.every((r) => r.state === "complete")).toBe(true);
	});

	it("isolates per-subagent failures", async () => {
		// One subagent's spawn failure must not abort
		// siblings — the tool returns whatever did work
		// alongside the failure record.
		const cancellations = new FleetCancellationRegistry();
		const runPi: RunPi = async ({ reviewerId }) => {
			if (reviewerId === "bad") throw new Error("kaboom");
			return {
				exitCode: 0,
				lines: [],
				finalAssistantText: `${reviewerId} ok`,
				stderr: "",
				warnings: [],
			};
		};
		const result = await dispatchFleet({
			runId: "r2",
			assignments: [
				assignment("good").assignment,
				assignment("bad").assignment,
			],
			runPi,
			cancellations,
		});
		const good = result.results.find((r) => r.id === "good");
		const bad = result.results.find((r) => r.id === "bad");
		expect(good?.state).toBe("complete");
		expect(bad?.state).toBe("failed");
		expect(bad?.error).toContain("kaboom");
	});

	it("aggregates usage across subagents", async () => {
		// totalUsage gives the user one-glance spend
		// without summing manually across results.
		const cancellations = new FleetCancellationRegistry();
		const usageA = makeUsage(100, 50);
		const usageB = makeUsage(200, 75);
		const runPi: RunPi = async ({ reviewerId }) => ({
			exitCode: 0,
			lines: [],
			finalAssistantText: `${reviewerId} done`,
			stderr: "",
			warnings: [],
			usage: reviewerId === "a" ? usageA : usageB,
		});
		const result = await dispatchFleet({
			runId: "r3",
			assignments: [assignment("a").assignment, assignment("b").assignment],
			runPi,
			cancellations,
		});
		expect(result.totalUsage?.tokens.input).toBe(300);
		expect(result.totalUsage?.tokens.output).toBe(125);
		expect(result.totalUsage?.tokens.total).toBe(425);
	});

	it("notifies the progress observer in lifecycle order", async () => {
		// Observer ordering pins the contract: start →
		// subagentStarted → subagentCompleted → finish.
		// Tool UIs depend on this sequence to set up and
		// tear down the focused panel correctly.
		const cancellations = new FleetCancellationRegistry();
		const { progress, events, starts } = recordingProgress();
		const runPi: RunPi = async ({ reviewerId }) => ({
			exitCode: 0,
			lines: [],
			finalAssistantText: `${reviewerId} done`,
			stderr: "",
			warnings: [],
		});
		await dispatchFleet({
			runId: "r4",
			assignments: [assignment("solo").assignment],
			runPi,
			cancellations,
			progress,
		});
		expect(starts).toHaveLength(1);
		expect(starts[0]).toHaveLength(1);
		expect(starts[0][0].state).toBe("pending");
		expect(events).toEqual(["start:solo", "complete:solo", "finish"]);
	});

	it("surfaces user cancellation as a cancelled-state result", async () => {
		// When the user cancels mid-flight the orchestrator
		// must distinguish that from spawn failure so the UI
		// can label it accurately and so retries know it
		// was intentional.
		const cancellations = new FleetCancellationRegistry();
		const { progress, events } = recordingProgress();
		const runPi: RunPi = async (opts) => {
			// Mid-run, cancel the running subagent through
			// the registry. The engine's signal propagation
			// surfaces as an AbortError; the orchestrator
			// translates that into a cancelled result.
			cancellations.cancel(opts.reviewerId);
			throw new DOMException("aborted", "AbortError");
		};
		const result = await dispatchFleet({
			runId: "r5",
			assignments: [assignment("victim").assignment],
			runPi,
			cancellations,
			progress,
		});
		expect(result.results[0].state).toBe("cancelled");
		expect(events).toContain("cancelled:victim");
	});

	it("threads onEvent activity into the progress observer", async () => {
		// Live activity hints are how the UI shows mid-
		// flight signal ("reading task.go") instead of
		// dead air. The runner emits stream events; the
		// orchestrator summarises them and forwards via
		// subagentActivity.
		const cancellations = new FleetCancellationRegistry();
		const { progress, events } = recordingProgress();
		const runPi: RunPi = async ({ onEvent }) => {
			onEvent?.({
				type: "tool_execution_start",
				toolName: "read",
				args: { path: "src/foo.ts" },
			});
			return {
				exitCode: 0,
				lines: [],
				finalAssistantText: "done",
				stderr: "",
				warnings: [],
			};
		};
		await dispatchFleet({
			runId: "r6",
			assignments: [assignment("watcher").assignment],
			runPi,
			cancellations,
			progress,
		});
		expect(events.some((e) => e.startsWith("activity:watcher:"))).toBe(true);
	});

	it("reports non-zero pi exits as failed, not complete", async () => {
		// A subagent that exits 1, 124 (timeout) or 130 (SIGINT)
		// produces a SubagentRunResult with exitCode set;
		// `runSubagent` doesn't throw. The orchestrator has
		// to translate that into a failed state so the host
		// agent doesn't act on partial output as if it were
		// complete.
		const cancellations = new FleetCancellationRegistry();
		const { progress, events } = recordingProgress();
		const runPi: RunPi = async () => ({
			exitCode: 1,
			lines: [],
			finalAssistantText: "partial",
			stderr: "boom",
			warnings: [],
		});
		const result = await dispatchFleet({
			runId: "r-exit",
			assignments: [assignment("bad-exit").assignment],
			runPi,
			cancellations,
			progress,
		});
		expect(result.results[0].state).toBe("failed");
		expect(result.results[0].error).toMatch(/exited with code 1/);
		expect(result.results[0].finalAssistantText).toBe("partial");
		expect(events.some((e) => e.startsWith("failed:bad-exit:"))).toBe(true);
	});

	it("inlines a stderr tail into the failure reason and preserves the full text", async () => {
		// The previous test confirmed exit-code propagation;
		// this one pins the new contract: an LLM caller acting
		// on the failed result must see *why* (e.g. missing
		// API key, unknown flag) directly in `error` without
		// having to open the supervisor's on-disk stderr file.
		// The raw text is also preserved on the result for
		// diagnostic UIs that want it verbatim.
		const cancellations = new FleetCancellationRegistry();
		const { progress, events } = recordingProgress();
		const stderr =
			"No API key found for anthropic.\n\nUse /login to log into a provider via OAuth or API key.\n";
		const runPi: RunPi = async () => ({
			exitCode: 1,
			lines: [],
			finalAssistantText: "",
			stderr,
			warnings: [],
		});
		const result = await dispatchFleet({
			runId: "r-stderr",
			assignments: [assignment("unauth").assignment],
			runPi,
			cancellations,
			progress,
		});
		const failure = result.results[0];
		expect(failure.state).toBe("failed");
		expect(failure.error).toMatch(/exited with code 1/);
		expect(failure.error).toMatch(/No API key found for anthropic/);
		expect(failure.stderr).toBe(stderr);
		expect(
			events.some((e) => e.includes("failed:unauth:") && e.includes("API key")),
		).toBe(true);
	});

	it("omits `stderr` when the child wrote nothing to stderr", async () => {
		// Spending a field on an empty string would noise up
		// the structured payload. Only attach `stderr` when
		// there's something worth attaching.
		const cancellations = new FleetCancellationRegistry();
		const runPi: RunPi = async () => ({
			exitCode: 1,
			lines: [],
			finalAssistantText: "",
			stderr: "",
			warnings: [],
		});
		const result = await dispatchFleet({
			runId: "r-quiet",
			assignments: [assignment("quiet-fail").assignment],
			runPi,
			cancellations,
		});
		const failure = result.results[0];
		expect(failure.state).toBe("failed");
		expect(failure.error).toBe("pi exited with code 1");
		expect(failure.stderr).toBeUndefined();
	});

	it("rejects duplicate subagent ids before dispatch", async () => {
		// The cancellation registry keys active subagents by
		// id; duplicates would silently overwrite each other
		// and make cancel-one unreliable. Reject early with
		// a structured error that names the offending id so
		// the caller knows what to fix.
		const cancellations = new FleetCancellationRegistry();
		const runPi: RunPi = async () => ({
			exitCode: 0,
			lines: [],
			finalAssistantText: "",
			stderr: "",
			warnings: [],
		});
		await expect(
			dispatchFleet({
				runId: "r-dup",
				assignments: [
					assignment("twin").assignment,
					assignment("twin").assignment,
				],
				runPi,
				cancellations,
			}),
		).rejects.toThrow(/Duplicate subagent id\(s\) in fleet: "twin"/);
	});

	it("calls finish even when an observer method throws", async () => {
		// Progress reporters are best-effort; a broken
		// observer must not strand the focused panel by
		// preventing finish() from running.
		const cancellations = new FleetCancellationRegistry();
		const finishSpy = vi.fn();
		const progress: FleetProgress = {
			start() {
				throw new Error("oops");
			},
			subagentStarted() {},
			subagentCompleted() {},
			subagentFailed() {},
			finish: finishSpy,
		};
		const runPi: RunPi = async () => ({
			exitCode: 0,
			lines: [],
			finalAssistantText: "ok",
			stderr: "",
			warnings: [],
		});
		await dispatchFleet({
			runId: "r7",
			assignments: [assignment("a").assignment],
			runPi,
			cancellations,
			progress,
		});
		expect(finishSpy).toHaveBeenCalledOnce();
	});
});

describe("buildAssignment", () => {
	it("defaults isolation to true at the tool boundary", () => {
		// Library default is `false` to serve pr-workflow;
		// the fleet tool defaults to `true` because clean-
		// slate runs are the common case here. Without this
		// inversion the user's local pi setup would leak
		// into every fleet subagent.
		const out = buildAssignment({
			id: "a",
			cwd: "/tmp",
			userPrompt: "do work",
		});
		expect(out.job.isolated).toBe(true);
	});

	it("honours an explicit isolated=false override", () => {
		const out = buildAssignment({
			id: "a",
			cwd: "/tmp",
			userPrompt: "do work",
			isolated: false,
		});
		expect(out.job.isolated).toBe(false);
	});

	it("separates spec fields from job fields", () => {
		const out = buildAssignment({
			id: "persona",
			model: "anthropic/claude-haiku-4-7",
			thinkingLevel: "high",
			tools: ["read", "grep"],
			cwd: "/tmp/wt",
			systemPrompt: "You are a security reviewer.",
			userPrompt: "audit auth.go",
		});
		expect(out.spec).toEqual({
			id: "persona",
			model: "anthropic/claude-haiku-4-7",
			thinkingLevel: "high",
			tools: ["read", "grep"],
		});
		expect(out.job.systemPrompt).toBe("You are a security reviewer.");
		expect(out.job.userPrompt).toBe("audit auth.go");
	});

	it("renames the tool's `extraSkills` field through to the engine job", () => {
		// The new public engine API uses `extraSkills` to
		// match its sibling `extraExtensions`. Catch any
		// future drift where the tool boundary forwards an
		// out-of-date `skills` field that the engine would
		// silently drop on the floor (spread-into-typed-
		// object skips excess-property checks).
		const out = buildAssignment({
			id: "with-skills",
			cwd: "/tmp",
			userPrompt: "x",
			extraSkills: ["/abs/skill.md"],
		});
		expect(out.job.extraSkills).toEqual(["/abs/skill.md"]);
	});

	it("forwards per-job timeout overrides into the engine job", () => {
		// Long-running personas (gsperf bench runs, gcloud
		// deploys, soak tests) need to override the
		// supervisor's idle and wall-clock defaults without
		// bumping them globally. The tool boundary takes
		// milliseconds as plain integers and passes them
		// straight through to the engine job.
		const out = buildAssignment({
			id: "long-running",
			cwd: "/tmp",
			userPrompt: "bench",
			timeoutMs: 45 * 60 * 1000,
			idleTimeoutMs: 15 * 60 * 1000,
		});
		expect(out.job.timeoutMs).toBe(45 * 60 * 1000);
		expect(out.job.idleTimeoutMs).toBe(15 * 60 * 1000);
	});

	it("omits timeout fields entirely when the caller doesn't set them", () => {
		// The engine treats `undefined` as "use the runner's
		// configured default". Leaving the keys absent (rather
		// than passing `undefined`) keeps the job payload
		// minimal and round-trips cleanly through JSON.
		const out = buildAssignment({
			id: "default-timeouts",
			cwd: "/tmp",
			userPrompt: "x",
		});
		expect("timeoutMs" in out.job).toBe(false);
		expect("idleTimeoutMs" in out.job).toBe(false);
	});

	it("forwards verify packs with and without companion skills", () => {
		const withSkill = buildAssignment({
			id: "v",
			cwd: "/tmp",
			userPrompt: "x",
			verify: {
				extensionPath: "/abs/v.ts",
				skillPath: "/abs/v.md",
			},
		});
		expect(withSkill.job.verify).toEqual({
			extensionPath: "/abs/v.ts",
			skillPath: "/abs/v.md",
		});
		const withoutSkill = buildAssignment({
			id: "v",
			cwd: "/tmp",
			userPrompt: "x",
			verify: { extensionPath: "/abs/v.ts" },
		});
		expect(withoutSkill.job.verify).toEqual({ extensionPath: "/abs/v.ts" });
	});
});

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
		expect(tail.endsWith("...")).toBe(true);
	});
});
