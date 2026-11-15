/**
 * How `dispatchFleet` runs a fleet.
 *
 * The orchestrator threads the engine, the cancellation
 * registry and the progress observer together. These
 * tests use fake runners + array-backed observers so the
 * integration is exercised without spawning real pi
 * processes or rendering a TUI.
 */

import { describe, expect, it, vi } from "vitest";
import { FleetCancellationRegistry } from "../../../extensions/subagent-workflow/cancellation.ts";
import type {
	FleetProgress,
	FleetProgressEntry,
} from "../../../extensions/subagent-workflow/progress.ts";
import {
	dispatchFleet,
	type FleetAssignment,
} from "../../../extensions/subagent-workflow/run.ts";
import type { RunRecord } from "../../../lib/core/observability/index.ts";
import { registerRunRecorder } from "../../../lib/core/observability/index.ts";
import { UNFINISHED } from "../../../lib/subagent/reviewer-error.ts";
import type { RunPi, RunPiResult } from "../../../lib/subagent/subagent.ts";
import { at } from "../../support/at.ts";
import { makeUsage } from "./fleet-usage.ts";

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
		expect(result.results.filter((r) => r.state !== "complete")).toEqual([]);
	});

	it("files each job with the level it launched at and the session it billed under", async () => {
		// The run table could say neither: 30 percent of fleet jobs launch
		// at xhigh, and a job's bill could only be found by summing tokens.
		const kept: RunRecord[] = [];
		const stop = registerRunRecorder((record) => kept.push(record));
		try {
			const runPi: RunPi = async ({ reviewerId }) => ({
				exitCode: 0,
				finalAssistantText: "done",
				warnings: [],
				sessionIds: [`session-of-${reviewerId}`],
			});
			await dispatchFleet({
				runId: "r1",
				assignments: [
					{
						spec: { id: "deep", thinkingLevel: "xhigh" },
						job: { userPrompt: "p", cwd: "/tmp" },
					},
					{ spec: { id: "inherits" }, job: { userPrompt: "p", cwd: "/tmp" } },
				],
				runPi,
				cancellations: new FleetCancellationRegistry(),
			});
		} finally {
			stop();
		}

		const byId = new Map(kept.map((record) => [record.subagentId, record]));
		expect(byId.get("deep")?.thinkingLevel).toBe("xhigh");
		expect(byId.get("deep")?.subagentSessionIds).toEqual(["session-of-deep"]);
		// Left to inherit pi's default, which this process cannot see.
		expect(byId.get("inherits")?.thinkingLevel).toBeNull();
	});

	it("isolates per-subagent failures", async () => {
		// One subagent's spawn failure must not abort
		// siblings, since the tool returns whatever did work
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
		expect(starts[0]?.[0]?.state).toBe("pending");
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
			cancellations.cancel("r5", opts.reviewerId);
			throw new DOMException("aborted", "AbortError");
		};
		const result = await dispatchFleet({
			runId: "r5",
			assignments: [assignment("victim").assignment],
			runPi,
			cancellations,
			progress,
		});
		expect(result.results[0]?.state).toBe("cancelled");
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
		expect(events).toContainEqual(expect.stringMatching(/^activity:watcher:/));
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
		expect(result.results[0]?.state).toBe("failed");
		expect(result.results[0]?.error).toMatch(/exited with code 1/);
		expect(result.results[0]?.finalAssistantText).toBe("partial");
		expect(events).toContainEqual(expect.stringMatching(/^failed:bad-exit:/));
	});

	it("reports a terminal provider error as failed even when pi exits zero", async () => {
		// A dropped model stream ends the final turn on an error
		// while the child still exits 0. The orchestrator must
		// treat the structured terminal error as a failure, not
		// report the partial output as a clean completion.
		const cancellations = new FleetCancellationRegistry();
		const { progress, events } = recordingProgress();
		const runPi: RunPi = async () => ({
			exitCode: 0,
			lines: [],
			finalAssistantText: "partial",
			stderr: "",
			warnings: [],
			error: {
				stopReason: "error",
				message:
					"OpenAI Responses stream ended before a terminal response event",
			},
		});
		const result = await dispatchFleet({
			runId: "r-terminal",
			assignments: [assignment("dropped").assignment],
			runPi,
			cancellations,
			progress,
		});
		expect(result.results[0]?.state).toBe("failed");
		expect(result.results[0]?.error).toMatch(/stream ended/);
		expect(events).toContainEqual(expect.stringMatching(/^failed:dropped:/));
	});

	it("reports a subagent that exited partway as failed, in words that say so", async () => {
		// Pi can leave with exit 0 before its run ends, which is not a
		// provider error at all, so "ended on a unfinished error" would be
		// both ungrammatical and a wrong account of what happened.
		const cancellations = new FleetCancellationRegistry();
		const { progress } = recordingProgress();
		const runPi: RunPi = async () => ({
			exitCode: 0,
			lines: [],
			finalAssistantText: "let me look",
			stderr: "",
			warnings: [],
			error: {
				stopReason: UNFINISHED,
				message:
					"pi exited with code 0 while web_read was still running, before its run ended.",
			},
		});
		const result = await dispatchFleet({
			runId: "r-partway",
			assignments: [assignment("partway").assignment],
			runPi,
			cancellations,
			progress,
		});

		expect(result.results[0]?.state).toBe("failed");
		expect(result.results[0]?.error).toMatch(
			/^pi stopped before its run finished: /,
		);
		expect(result.results[0]?.error).toContain("web_read");
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
		const failure = at(result.results, 0);
		expect(failure.state).toBe("failed");
		expect(failure.error).toMatch(/exited with code 1/);
		expect(failure.error).toMatch(/No API key found for anthropic/);
		expect(failure.stderr).toBe(stderr);
		expect(events.filter((e) => e.includes("failed:unauth:"))).toContainEqual(
			expect.stringContaining("API key"),
		);
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
		const failure = at(result.results, 0);
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
		).rejects.toThrow(/Duplicate subagent id in fleet: "twin"/);
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
