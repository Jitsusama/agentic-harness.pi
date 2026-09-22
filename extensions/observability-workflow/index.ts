/**
 * Observability Workflow extension.
 *
 * Records one telemetry row per subagent as it finishes,
 * into a SQLite table kept in this extension's own state
 * directory (separate from the memory store, so telemetry
 * pruning can never touch curated facts). The parent
 * session is the single writer; ephemeral subagents never
 * touch the file.
 *
 * The extension registers a recorder sink that the fleet
 * dispatcher and the council runner emit into, and exposes a
 * no-command `observe_runs` query tool.
 *
 * Nothing is ever discarded. Rows used to be rolled into
 * weekly summaries and deleted at session start, which
 * destroyed the detail behind 2,199 runs and $11,926 before
 * anyone looked. Summaries are computed from the rows now,
 * so they cost a query instead of the evidence.
 *
 * It deliberately shows no cost of its own. `cost-workflow`
 * subscribes to the same recorder and folds fan-out into the
 * one money figure on the status line, because a council round
 * is the same money as the turn that asked for it and two
 * readings of it invite adding them together.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	openRunStore,
	type RunRecord,
	type RunRollup,
	type RunStore,
	type RunSummary,
	registerRunRecorder,
} from "@jitsusama/agentic-harness.core/observability";
import { Type } from "@sinclair/typebox";
import { packageStateDir } from "../../lib/internal/package-state-dir.js";

/** Result payload the observe_runs tool returns. */
interface ObserveDetails {
	readonly ok: boolean;
	readonly summary?: RunSummary | null;
	readonly runCount?: number;
}

export default function observabilityWorkflow(pi: ExtensionAPI) {
	let store: RunStore | null = null;
	let unregister: (() => void) | null = null;
	// In-flight writes, drained at shutdown so a run recorded just
	// before the process exits is not lost to the async gap between
	// recordRun and the sqlite flush.
	const pendingWrites = new Set<Promise<unknown>>();

	pi.on("session_start", async () => {
		if (store === null) {
			const dir = packageStateDir("observability");
			mkdirSync(dir, { recursive: true });
			store = await openRunStore(join(dir, "runs.db"));
			unregister = registerRunRecorder((record) => {
				const write =
					store?.recordRun(record).catch(() => {
						// Best-effort telemetry: never disturb the run.
					}) ?? Promise.resolve();
				pendingWrites.add(write);
				void write.finally(() => pendingWrites.delete(write));
			});
		}
	});

	const teardown = async (): Promise<void> => {
		unregister?.();
		unregister = null;
		// Let in-flight writes reach disk before the store closes, so
		// a run recorded moments before shutdown is not dropped.
		await Promise.allSettled([...pendingWrites]);
		const closing = store;
		store = null;
		if (closing) {
			try {
				await closing.close();
			} catch {
				// Closing a telemetry DB is best-effort at shutdown.
			}
		}
	};
	pi.on("session_shutdown", async () => {
		await teardown();
	});

	pi.registerTool({
		name: "observe_runs",
		label: "Observe Runs",
		description:
			"Query subagent and council run telemetry: how a fan-out did " +
			"and what it cost. Pass a runId to summarize one run (subagent " +
			"count, verify pass/fail, retries, warnings, tokens, cost, cache " +
			"ratio); omit it for recent runs in the retention window plus the " +
			"weekly per-model and per-persona trend rollups.",
		promptSnippet:
			"Answer how a council or fleet run did and what it cost from the " +
			"recorded run table.",
		parameters: Type.Object({
			runId: Type.Optional(
				Type.String({
					description:
						"A specific fleet or council run id to summarize. Omit for a recent-runs digest plus trend rollups.",
				}),
			),
		}),
		async execute(
			_toolCallId,
			params,
		): Promise<AgentToolResult<ObserveDetails>> {
			if (!store) {
				return {
					content: [{ type: "text", text: "Observability store is not open." }],
					details: { ok: false },
				};
			}
			if (params.runId) {
				const summary = await store.summarizeRun(params.runId);
				const text = summary
					? formatRunSummary(summary)
					: `No runs recorded for ${params.runId}.`;
				return {
					content: [{ type: "text", text }],
					details: { ok: true, summary },
				};
			}
			const rows = await store.queryRuns();
			const rollups = await store.queryRollups();
			return {
				content: [{ type: "text", text: formatDigest(rows, rollups) }],
				details: { ok: true, runCount: rows.length },
			};
		},
	});
}

interface RunSummaryLike {
	readonly runId: string;
	readonly subagentCount: number;
	readonly passed: number;
	readonly failed: number;
	readonly totalRetries: number;
	readonly totalWarnings: number;
	readonly tokens: { readonly total: number };
	readonly cost: { readonly total: number };
	readonly cacheReadRatio: number;
}

function formatRunSummary(s: RunSummaryLike): string {
	return [
		`Run ${s.runId}: ${s.subagentCount} subagents, ${s.passed} passed, ${s.failed} failed`,
		`retries ${s.totalRetries}, warnings ${s.totalWarnings}`,
		`tokens ${s.tokens.total}, cost $${s.cost.total.toFixed(4)}, cache-read ${(s.cacheReadRatio * 100).toFixed(0)}%`,
	].join("\n");
}

export function formatDigest(
	rows: readonly RunRecord[],
	rollups: readonly RunRollup[],
): string {
	if (rows.length === 0 && rollups.length === 0) {
		return "No runs recorded yet.";
	}
	const lines: string[] = [];
	const byRun = groupByRun(rows);
	if (byRun.length > 0) {
		lines.push(`Recent runs (${byRun.length} in window):`);
		for (const run of byRun.slice(0, 10)) {
			lines.push(
				`- ${run.runId} (${run.kind}): ${run.subagentCount} subagents, ` +
					`${run.passed} passed / ${run.failed} failed, $${run.cost.toFixed(4)}`,
			);
		}
	}
	if (rollups.length > 0) {
		lines.push("", "Weekly trends:");
		for (const r of rollups) {
			const week = new Date(r.weekStart).toISOString().slice(0, 10);
			lines.push(
				`- ${week} ${r.model || "(default)"} / ${r.persona}: ` +
					`${r.runCount} runs, ${r.totalRetries} retries, ` +
					`$${r.costTotal.toFixed(4)}, cache-read ${(r.cacheReadRatio * 100).toFixed(0)}%`,
			);
		}
	}
	return lines.join("\n");
}

interface RunGroup {
	runId: string;
	kind: string;
	subagentCount: number;
	passed: number;
	failed: number;
	cost: number;
}

export function groupByRun(rows: readonly RunRecord[]): RunGroup[] {
	const groups = new Map<string, RunGroup>();
	for (const row of rows) {
		const group = groups.get(row.runId) ?? {
			runId: row.runId,
			kind: row.kind,
			subagentCount: 0,
			passed: 0,
			failed: 0,
			cost: 0,
		};
		group.subagentCount += 1;
		if (row.verifyOutcome === "passed") group.passed += 1;
		if (row.verifyOutcome === "failed") group.failed += 1;
		group.cost += row.cost.total;
		groups.set(row.runId, group);
	}
	return [...groups.values()];
}
