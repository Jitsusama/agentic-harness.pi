import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReviewerRunArtifacts } from "./subagent.js";

/** Terminal lifecycle states persisted by supervised reviewer runs. */
export type ReviewerTerminalState =
	| "complete"
	| "failed"
	| "cancelled"
	| "timeout"
	| "idle-timeout"
	| "output-limit"
	| "parent-exit";

/** Paths owned by one reviewer job. */
export interface ReviewerRunPaths extends ReviewerRunArtifacts {
	readonly requestPath: string;
	readonly leasePath: string;
	readonly cancelPath: string;
}

/** Paths owned by a whole reviewer run. */
export interface ReviewerRunRootPaths {
	readonly runDir: string;
	readonly runPath: string;
	readonly cancelPath: string;
	readonly reviewersDir: string;
}

/** Result of appending to a capped artifact. */
export interface AppendOutcome {
	readonly written: boolean;
	readonly bytesAfter: number;
	readonly limitExceeded: boolean;
}

/** Retention policy for terminal reviewer run directories. */
export interface RetentionPolicy {
	readonly maxAgeMs: number;
	readonly maxRuns: number;
	readonly now?: Date;
}

/** Summary returned by retention cleanup. */
export interface CleanupSummary {
	readonly removed: number;
	readonly kept: number;
	readonly warnings: readonly string[];
}

const SCHEMA_VERSION = 1;

/** File-backed artifact store for supervised reviewer runs. */
export class ReviewerArtifactsStore {
	readonly stateDir: string;
	readonly runsDir: string;

	constructor(stateDir: string) {
		this.stateDir = stateDir;
		this.runsDir = join(stateDir, "runs");
	}

	/** Return paths for a whole reviewer run. */
	rootPaths(runId: string): ReviewerRunRootPaths {
		const runDir = join(this.runsDir, safeSegment(runId));
		return {
			runDir,
			runPath: join(runDir, "run.json"),
			cancelPath: join(runDir, "cancel.json"),
			reviewersDir: join(runDir, "reviewers"),
		};
	}

	/** Return paths for one reviewer in a run. */
	paths(runId: string, reviewerId: string): ReviewerRunPaths {
		const root = this.rootPaths(runId);
		const reviewerDir = join(root.reviewersDir, safeSegment(reviewerId));
		return {
			runDir: root.runDir,
			reviewerDir,
			requestPath: join(reviewerDir, "request.json"),
			leasePath: join(reviewerDir, "lease.json"),
			cancelPath: join(reviewerDir, "cancel.json"),
			eventsPath: join(reviewerDir, "events.ndjson"),
			stderrPath: join(reviewerDir, "stderr.log"),
			progressPath: join(reviewerDir, "progress.json"),
			resultPath: join(reviewerDir, "result.json"),
		};
	}

	/** Create the directories needed for a reviewer job. */
	async ensureReviewerDir(
		runId: string,
		reviewerId: string,
	): Promise<ReviewerRunPaths> {
		const paths = this.paths(runId, reviewerId);
		await mkdir(paths.reviewerDir, { recursive: true });
		return paths;
	}

	/** Write JSON by temp-file + rename so readers never see a partial object. */
	async writeJsonAtomic(path: string, value: unknown): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
		await rename(tmp, path);
	}

	/** Read JSON, returning null for absent files. */
	async readJson<T>(path: string): Promise<T | null> {
		try {
			return JSON.parse(await readFile(path, "utf-8")) as T;
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	}

	/** Append bytes unless doing so would exceed the configured cap. */
	async appendCapped(
		path: string,
		chunk: Buffer,
		maxBytes: number,
	): Promise<AppendOutcome> {
		await mkdir(dirname(path), { recursive: true });
		const current = await fileSize(path);
		const bytesAfter = current + chunk.byteLength;
		if (bytesAfter > maxBytes) {
			return { written: false, bytesAfter, limitExceeded: true };
		}
		await writeFile(path, chunk, { flag: "a" });
		return { written: true, bytesAfter, limitExceeded: false };
	}

	/** Write a run-wide cancellation request. */
	async requestRunCancellation(runId: string, reason: string): Promise<void> {
		await this.writeJsonAtomic(this.rootPaths(runId).cancelPath, {
			schemaVersion: SCHEMA_VERSION,
			reason,
			requestedAt: new Date().toISOString(),
		});
	}

	/** Write a per-reviewer cancellation request. */
	async requestReviewerCancellation(
		runId: string,
		reviewerId: string,
		reason: string,
	): Promise<void> {
		await this.writeJsonAtomic(this.paths(runId, reviewerId).cancelPath, {
			schemaVersion: SCHEMA_VERSION,
			reason,
			requestedAt: new Date().toISOString(),
		});
	}

	/** Remove old terminal run directories according to a bounded policy. */
	async cleanupTerminalRuns(policy: RetentionPolicy): Promise<CleanupSummary> {
		const warnings: string[] = [];
		const entries = await listDirs(this.runsDir);
		const runs = await Promise.all(
			entries.map(async (name) => {
				const runDir = join(this.runsDir, name);
				return { name, runDir, mtimeMs: (await stat(runDir)).mtimeMs };
			}),
		);
		const sorted = runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
		let removed = 0;
		let kept = 0;
		const now = policy.now?.getTime() ?? Date.now();
		for (let index = 0; index < sorted.length; index++) {
			const run = sorted[index];
			const terminal = await isTerminalRun(run.runDir);
			const tooOld = now - run.mtimeMs > policy.maxAgeMs;
			const tooMany = index >= policy.maxRuns;
			if (terminal && (tooOld || tooMany)) {
				try {
					await rm(run.runDir, { recursive: true, force: true });
					removed++;
				} catch (error) {
					warnings.push(
						`Failed to remove ${run.runDir}: ${errorMessage(error)}`,
					);
				}
			} else {
				kept++;
			}
		}
		return { removed, kept, warnings };
	}
}

function safeSegment(value: string): string {
	const clean = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return clean.length > 0 ? clean : "unknown";
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if (isNotFound(error)) return 0;
		throw error;
	}
}

async function listDirs(path: string): Promise<string[]> {
	try {
		const entries = await readdir(path, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
}

async function isTerminalRun(runDir: string): Promise<boolean> {
	const reviewersDir = join(runDir, "reviewers");
	const reviewers = await listDirs(reviewersDir);
	if (reviewers.length === 0) return false;
	for (const reviewer of reviewers) {
		try {
			await stat(join(reviewersDir, reviewer, "result.json"));
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}
	return true;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
