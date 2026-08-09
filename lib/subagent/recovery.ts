import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
	ReviewerArtifactsStore,
	ReviewerTerminalState,
} from "./artifacts.js";
import type { LeaseRecord, ProcessFacts } from "./lease.js";
import { sameProcess, supervisorStanding, systemFacts } from "./lease.js";
import type { ReviewerUsage } from "./subagent.js";

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

/** A reviewer's own process, killed because nothing was left to own it. */
export interface ReapedReviewerChild {
	readonly runId: string;
	readonly reviewerId: string;
	readonly pid: number;
}

/**
 * How a reaper decides, and how it kills.
 *
 * Injected because both answers are about the machine rather than
 * about recovery, and because a test that reaps for real is a test
 * that kills a process by a number it read from a file.
 */
export interface ReaperDeps extends ProcessFacts {
	/** Signal the process group this pid leads. */
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
	/** Pause, so a terminated process has a moment to go. */
	wait(ms: number): Promise<void>;
}

/** Summary of startup recovery across supervised reviewer runs. */
export interface RecoverySummary {
	readonly completed: readonly RecoveredReviewerResult[];
	readonly active: readonly RecoveredReviewerProgress[];
	readonly stale: readonly RecoveredReviewerProgress[];
	/** Reviewer processes killed because their supervisor was gone. */
	readonly reaped: readonly ReapedReviewerChild[];
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

/** Recover durable supervised reviewer state after extension activation or reload. */
export async function recoverReviewerRuns(
	store: ReviewerArtifactsStore,
	reaper: ReaperDeps = systemReaper,
): Promise<RecoverySummary> {
	const completed: RecoveredReviewerResult[] = [];
	const active: RecoveredReviewerProgress[] = [];
	const stale: RecoveredReviewerProgress[] = [];
	const reaped: ReapedReviewerChild[] = [];
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
				const lease = await store.readJson<LeaseRecord>(paths.leasePath);
				// The same reader the collect path uses. Two readings of one
				// file that disagree is how a supervisor gets filed as
				// healthy here and dead there, and the asymmetry bites worst
				// on this side: a recycled pid reads as alive, the run is
				// filed active, and the orphan holding a model is never
				// cancelled or reaped.
				const standing = await supervisorStanding(
					store,
					runId,
					reviewerId,
					reaper,
				);
				if (standing.kind === "running" || standing.kind === "starting") {
					// Starting counts as active here, and the distinction is
					// the whole reason it exists. A run whose directory is
					// there and whose lease is not is one that began moments
					// ago, since the lease is written before anything is
					// spawned; filing it stale means a session starting in
					// that window cancels a job another session just
					// dispatched. There is nothing to reap either way, because
					// nothing has been spawned yet.
					active.push(progress);
				} else {
					stale.push(progress);
					await store.requestReviewerCancellation(
						runId,
						reviewerId,
						"startup-stale",
					);
					// The cancellation above is read by the supervisor, and
					// the supervisor is what just failed to answer. Its child
					// is a reviewer nobody is watching, holding a model open
					// against its own wall clock: three quarters of an hour
					// of an expensive model with no one to give the answer
					// to. Nothing else can reach it, because the pid was only
					// ever known to the process that died.
					const killed = await reap(lease, reaper);
					if (killed !== undefined) {
						reaped.push({ runId, reviewerId, pid: killed });
					}
				}
			} catch (error) {
				warnings.push(
					`Could not recover reviewer ${runId}/${reviewerId}: ${errorMessage(error)}`,
				);
			}
		}
	}
	return { completed, active, stale, reaped, warnings };
}

/**
 * Kill a reviewer whose supervisor is gone, if it is safe to say it is
 * the same process the lease named.
 *
 * Refusing is the default, and every uncertainty resolves that way: an
 * unknown start time, a platform that cannot report one, a process
 * whose birth does not match the lease's. The cost of refusing is a
 * reviewer that runs to its own backstop and stops; the cost of being
 * wrong is signalling a process group that has nothing to do with us,
 * and the pid space is small enough that this is not a remote
 * possibility on a machine that has been up for a while.
 *
 * SIGTERM first, because pi flushes its session on the way out and a
 * reviewer's journal is worth the pause. Then it is checked, and
 * escalated if it is still there, because a kill nobody confirms is a
 * report rather than an outcome.
 */
async function reap(
	lease: LeaseRecord | null,
	reaper: ReaperDeps,
): Promise<number | undefined> {
	if (lease === null) return undefined;
	if (typeof lease.completedAt === "string") return undefined;
	const pid = lease.childPid;
	const spawned = lease.childStartedAt;
	if (typeof pid !== "number" || pid <= 0) return undefined;
	if (typeof spawned !== "number") return undefined;
	if (!reaper.alive(pid)) return undefined;
	const startedAt = await reaper.startedAt(pid);
	if (startedAt === undefined) return undefined;
	if (!sameProcess(startedAt, spawned)) return undefined;

	reaper.kill(pid, "SIGTERM");
	await reaper.wait(TERM_GRACE_MS);
	if (reaper.alive(pid)) reaper.kill(pid, "SIGKILL");
	return pid;
}

/**
 * How long a reviewer is given to go quietly.
 *
 * Short, because this runs during a session's startup and an orphan
 * that ignores SIGTERM is not going to reconsider. Long enough for pi
 * to write out the session it was told to persist.
 */
const TERM_GRACE_MS = 500;

/** Asking the operating system, which is what the default has to do. */
const systemReaper: ReaperDeps = {
	startedAt: systemFacts.startedAt,
	alive: systemFacts.alive,
	async wait(ms) {
		await new Promise((resolve) => setTimeout(resolve, ms));
	},
	kill(pid, signal) {
		try {
			// The group, because the reviewer is spawned detached and
			// leads its own: killing the pid alone orphans whatever it
			// started, which is the problem being solved one level down.
			//
			// No fallback to the bare pid. A group kill fails when no
			// group leads by that number, which is precisely the evidence
			// that the process wearing the pid is not the detached child
			// the lease described. Signalling it anyway would spend the
			// identity check and then ignore it.
			process.kill(-pid, signal);
		} catch {
			// Gone between the check and the signal, or never ours. Both
			// end here, and neither wants a second attempt.
		}
	},
};

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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
