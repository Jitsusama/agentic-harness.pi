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

/**
 * Terminal lifecycle states persisted by supervised reviewer runs.
 *
 * `errored` is the one that is not a lifecycle event: the child exited
 * cleanly but its final turn died on a provider or transport failure,
 * so the supervisor downgrades `complete` to this. It was missing from
 * this union while `supervisor.mjs` was already writing it, which made
 * every read of the field a quiet lie and any exhaustive switch over
 * it wrong.
 */
export type ReviewerTerminalState =
	| "complete"
	| "errored"
	| "failed"
	| "cancelled"
	| "timeout"
	| "idle-timeout"
	| "output-limit"
	/**
	 * Stopped inside its wall clock, on purpose, so the rest of the
	 * budget could be spent asking it for what it had.
	 *
	 * The only state here that does not describe something going
	 * wrong. The run was healthy and was interrupted anyway.
	 */
	| "soft-deadline"
	| "parent-exit"
	/**
	 * Its supervisor went away, and nothing wrote it a result.
	 *
	 * The only state here no supervisor ever writes, because the
	 * supervisor is the thing that is missing. It is reconstructed by
	 * whoever finds the reviewer's journal on disk with no result
	 * beside it, and it exists so that reviewer cannot be recorded as
	 * one that read the change and answered: without a state, nothing
	 * downstream has any way to tell the two apart.
	 */
	| "supervisor-lost";

/** Paths owned by one reviewer job. */
export interface ReviewerRunPaths extends ReviewerRunArtifacts {
	/**
	 * Where this reviewer records findings as it forms them.
	 *
	 * Optional on {@link ReviewerRunArtifacts}, because a runner that
	 * keeps no artifacts has nowhere to put one, and required here,
	 * because these paths are derived from a directory that exists.
	 * Left optional, every caller writes a guard against a case that
	 * cannot arise, and one of them will eventually treat it as the
	 * reviewer having no journal rather than as impossible.
	 */
	readonly journalPath: string;
	readonly requestPath: string;
	readonly leasePath: string;
	readonly cancelPath: string;
	/** Where the reviewer's prompt is kept, when one was written. */
	readonly promptPath: string;
	/** Always set for a supervised run; the session lives here. */
	readonly sessionDir: string;
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

/** Retention policy for reviewer run directories. */
export interface RetentionPolicy {
	readonly maxAgeMs: number;
	readonly maxRuns: number;
	/**
	 * How long an unfinished run is kept before it is reclaimed anyway.
	 *
	 * A run whose reviewer never wrote a result is not terminal, and a
	 * terminal-only sweep can never reclaim it, so a run killed hard
	 * lives forever and the directory grows without bound. This window
	 * is deliberately separate from {@link maxAgeMs} and much longer:
	 * an unfinished run is kept for recovery, and the question is not
	 * whether it finished but whether anybody could still plausibly
	 * resume it. Omit to keep unfinished runs indefinitely, which is
	 * what the policy did before this existed.
	 */
	readonly abandonedAfterMs?: number;
	/**
	 * Runs to keep whatever their age, named by run id.
	 *
	 * For work that is finished on disk and unfinished to whoever is
	 * going to read it. A round detached from its session writes every
	 * result file and then waits, possibly for days, to be collected;
	 * to this sweep it looks exactly like a finished round nobody
	 * needs. Deleting it throws away reviews that have been paid for
	 * and leaves a ledger entry pointing at nothing.
	 */
	readonly protect?: ReadonlySet<string>;
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
			verifiedOutputPath: join(reviewerDir, "verified-output.json"),
			journalPath: join(reviewerDir, "journal.ndjson"),
			// What this reviewer was asked. Kept here rather than in a
			// temp file because a detached round has nobody to clean one
			// up, and because it is the only record of the question a
			// round that outlived its session was answering.
			promptPath: join(reviewerDir, "prompt.txt"),
			sessionDir: join(reviewerDir, "session"),
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
			const age = now - run.mtimeMs;
			const tooOld = age > policy.maxAgeMs;
			const tooMany = index >= policy.maxRuns;
			// An unfinished run is kept for recovery, but not forever: past
			// this window nobody is going to resume it, and leaving it is
			// how the directory grew unbounded.
			const abandoned =
				!terminal &&
				policy.abandonedAfterMs !== undefined &&
				age > policy.abandonedAfterMs;
			if (policy.protect?.has(run.name)) {
				kept++;
				continue;
			}
			if ((terminal && (tooOld || tooMany)) || abandoned) {
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
