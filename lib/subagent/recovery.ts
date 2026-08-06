import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
	ReviewerArtifactsStore,
	ReviewerTerminalState,
} from "./artifacts.js";
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
export interface ReaperDeps {
	/**
	 * When this process started, in epoch milliseconds, or undefined
	 * when nothing can be said about it.
	 *
	 * The whole safety of reaping rests here. A pid identifies nothing
	 * on its own, so the reaper needs to know whether the process
	 * wearing that number today is the one the lease was written
	 * about.
	 */
	startedAt(pid: number): Promise<number | undefined>;
	/** Kill the process group this pid leads. */
	kill(pid: number): void;
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

interface LeaseFile {
	readonly supervisorPid?: number | null;
	readonly childPid?: number | null;
	readonly childStartedAt?: number | null;
	readonly completedAt?: string | null;
	readonly state?: string;
}

/**
 * How much later than the lease says a process may have started and
 * still be believed to be the same one.
 *
 * The supervisor stamps the clock immediately after `spawn` returns,
 * and the operating system stamps its own a moment earlier, so the two
 * disagree by scheduling noise. Seconds rather than milliseconds
 * because `ps` reports whole seconds on the platforms that have it,
 * and a second of slack costs nothing: a recycled pid is minutes or
 * hours later, never two seconds.
 */
const SAME_PROCESS_MS = 2_000;

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
 * that started later than the lease says ours did. The cost of
 * refusing is a reviewer that runs to its own backstop and stops; the
 * cost of being wrong is killing something that has nothing to do with
 * us, and the pid space is small enough that this is not a remote
 * possibility on a machine that has been up for a while.
 */
async function reap(
	lease: LeaseFile | null,
	reaper: ReaperDeps,
): Promise<number | undefined> {
	if (lease === null) return undefined;
	if (typeof lease.completedAt === "string") return undefined;
	const pid = lease.childPid;
	const spawned = lease.childStartedAt;
	if (typeof pid !== "number" || pid <= 0) return undefined;
	if (typeof spawned !== "number") return undefined;
	if (!processAlive(pid)) return undefined;
	const startedAt = await reaper.startedAt(pid);
	if (startedAt === undefined) return undefined;
	if (startedAt > spawned + SAME_PROCESS_MS) return undefined;
	reaper.kill(pid);
	return pid;
}

/** Asking the operating system, which is what the default has to do. */
const systemReaper: ReaperDeps = {
	async startedAt(pid) {
		try {
			// `lstart` rather than `etime`, because elapsed time is
			// relative to now and the comparison wants an absolute
			// moment. Available on macOS and Linux; anywhere it is not,
			// this throws and the reaper declines, which is the right
			// way to fail.
			const { stdout } = await promisify(execFile)("ps", [
				"-o",
				"lstart=",
				"-p",
				String(pid),
			]);
			const parsed = Date.parse(stdout.trim());
			return Number.isNaN(parsed) ? undefined : parsed;
		} catch {
			// No such process, or no ps to ask. Either way nothing here
			// knows what it would be killing.
			return undefined;
		}
	},
	kill(pid) {
		try {
			// The group, because the reviewer is spawned detached and
			// leads its own: killing the pid alone orphans whatever it
			// started, which is the problem being solved one level down.
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Gone between the check and the signal, which is the
				// outcome we wanted anyway.
			}
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
