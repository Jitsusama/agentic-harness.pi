import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewerUsage } from "./reviewer.js";
import type {
	ReviewerArtifactsStore,
	ReviewerTerminalState,
} from "./reviewer-artifacts.js";

/** Compact recovered result for a supervised reviewer job. */
export interface RecoveredReviewerResult {
	readonly runId: string;
	readonly reviewerId: string;
	readonly state: ReviewerTerminalState;
	readonly exitCode: number;
	readonly finalAssistantText: string;
	readonly usage?: ReviewerUsage;
	readonly warnings: readonly string[];
	readonly resultPath: string;
}

/** Last-known progress snapshot loaded from disk. */
export interface RecoveredReviewerProgress {
	readonly runId: string;
	readonly reviewerId: string;
	readonly state: string;
	readonly activity: string;
	readonly updatedAt: string;
}

/** Summary of startup recovery across supervised reviewer runs. */
export interface RecoverySummary {
	readonly completed: readonly RecoveredReviewerResult[];
	readonly active: readonly RecoveredReviewerProgress[];
	readonly stale: readonly RecoveredReviewerProgress[];
	readonly warnings: readonly string[];
}

interface ResultFile {
	readonly state: ReviewerTerminalState;
	readonly exitCode: number;
	readonly finalAssistantText: string;
	readonly usage?: ReviewerUsage;
	readonly warnings?: readonly string[];
}

interface ProgressFile {
	readonly runId?: string;
	readonly reviewerId?: string;
	readonly state?: string;
	readonly activity?: string;
	readonly updatedAt?: string;
}

interface LeaseFile {
	readonly supervisorPid?: number | null;
	readonly state?: string;
}

/** Recover durable supervised reviewer state after extension activation or reload. */
export async function recoverReviewerRuns(
	store: ReviewerArtifactsStore,
): Promise<RecoverySummary> {
	const completed: RecoveredReviewerResult[] = [];
	const active: RecoveredReviewerProgress[] = [];
	const stale: RecoveredReviewerProgress[] = [];
	const warnings: string[] = [];
	for (const runId of await listDirs(store.runsDir)) {
		const reviewersDir = join(store.runsDir, runId, "reviewers");
		for (const reviewerId of await listDirs(reviewersDir)) {
			const paths = store.paths(runId, reviewerId);
			try {
				const result = await store.readJson<ResultFile>(paths.resultPath);
				if (result !== null) {
					completed.push({
						runId,
						reviewerId,
						state: result.state,
						exitCode: result.exitCode,
						finalAssistantText: result.finalAssistantText,
						...(result.usage ? { usage: result.usage } : {}),
						warnings: result.warnings ?? [],
						resultPath: paths.resultPath,
					});
					continue;
				}
				const progress = await readProgress(store, runId, reviewerId);
				const lease = await store.readJson<LeaseFile>(paths.leasePath);
				if (lease?.supervisorPid && processAlive(lease.supervisorPid)) {
					active.push(progress);
				} else {
					stale.push(progress);
					await store.requestReviewerCancellation(
						runId,
						reviewerId,
						"startup-stale",
					);
				}
			} catch (error) {
				warnings.push(
					`Could not recover reviewer ${runId}/${reviewerId}: ${errorMessage(error)}`,
				);
			}
		}
	}
	return { completed, active, stale, warnings };
}

async function readProgress(
	store: ReviewerArtifactsStore,
	runId: string,
	reviewerId: string,
): Promise<RecoveredReviewerProgress> {
	const paths = store.paths(runId, reviewerId);
	const progress = await store.readJson<ProgressFile>(paths.progressPath);
	return {
		runId,
		reviewerId,
		state: progress?.state ?? "unknown",
		activity: progress?.activity ?? "",
		updatedAt: progress?.updatedAt ?? "",
	};
}

async function listDirs(path: string): Promise<string[]> {
	try {
		const entries = await readdir(path, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
