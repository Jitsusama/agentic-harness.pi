/**
 * Whether the supervisor that owns a reviewer is still there.
 *
 * Its own module because three readers had grown their own answer and
 * disagreed. Startup recovery asked whether a pid was alive; the
 * collect path asked whether a heartbeat was fresh; the reaper asked
 * whether a process was the one a lease was written about. They read
 * the same file and drew opposite conclusions from it, which is how a
 * supervisor could be filed as healthy by one reader and dead by the
 * next.
 *
 * The hard part is that a pid identifies nothing. Nothing deletes a
 * lease, so a supervisor that finished hours ago leaves one naming its
 * number, and the operating system hands that number out again. Asking
 * whether the process wearing it today started when the lease says
 * ours did is the only question with a true answer.
 */

import { stat } from "node:fs/promises";
import {
	type ProcessFacts,
	SAME_PROCESS_MS,
	sameProcess,
	systemFacts,
} from "@jitsusama/agentic-harness.core/process";
import type { ReviewerArtifactsStore } from "./artifacts.js";

// Re-exported rather than moved out of sight. These were defined here
// first and the whole of `lib/subagent` imports them from here, so the
// extraction is not an excuse to touch thirty call sites.
export { type ProcessFacts, SAME_PROCESS_MS, sameProcess, systemFacts };

/**
 * How stale a heartbeat may be before its writer is presumed gone.
 *
 * Only consulted when a process cannot be identified, since a lease
 * that is being renewed says more than one that is merely recent.
 * Sixty missed beats, because the machine that renewed a lease every
 * second for 145 seconds under load 168 is the one this must survive.
 */
export const HEARTBEAT_STALE_MS = 60_000;

/** Where a supervisor stands, as far as anything on disk can say. */
export type SupervisorStanding =
	| { readonly kind: "running"; readonly pid: number; readonly sinceMs: number }
	| { readonly kind: "finished" }
	/**
	 * Written down, but not yet begun.
	 *
	 * Distinct from running, because nothing can be collected from it,
	 * and distinct from gone, because acting on it cancels a run that
	 * was moments from starting. Absent means not told yet.
	 */
	| { readonly kind: "starting" }
	| { readonly kind: "gone" };

/** What the lease holds about the two processes it describes. */
export interface LeaseRecord {
	readonly supervisorPid?: number | null;
	readonly supervisorStartedAt?: number | null;
	readonly childPid?: number | null;
	readonly childStartedAt?: number | null;
	readonly completedAt?: string | null;
	readonly updatedAt?: string | null;
	readonly state?: string;
}

/**
 * Where the supervisor of one reviewer stands.
 *
 * Identity first, and it is decisive both ways: a matching start time
 * means the supervisor is ours and running, however stale its
 * heartbeat, because a wedged supervisor is still one whose round must
 * not be collected out from under it. A mismatch means the pid belongs
 * to a stranger and the supervisor is gone, however alive the pid
 * looks.
 *
 * The heartbeat is the fallback for a machine that cannot identify a
 * process at all, and for leases written before identity was recorded.
 * It fails open, which is the wrong direction, so it is what happens
 * when there is nothing better rather than what happens by default.
 */
export async function supervisorStanding(
	store: ReviewerArtifactsStore,
	runId: string,
	reviewerId: string,
	facts: ProcessFacts,
	now: number = Date.now(),
): Promise<SupervisorStanding> {
	const { leasePath } = store.paths(runId, reviewerId);
	const lease = await store.readJson<LeaseRecord>(leasePath).catch(() => null);
	// No lease at all is not a supervisor that has gone: it is one that
	// has not written yet. The supervisor writes this before it spawns
	// anything, so there is a window at the start of every run where
	// the directory exists and the lease does not, and reading that as
	// "gone" means another session starting in that moment cancels a
	// job that is just getting going. Nothing has been spawned yet
	// either, so there is nothing there to reap by mistake.
	//
	// Bounded, because an absence on its own never resolves: a
	// supervisor killed before it wrote anything leaves a directory
	// that is starting forever, and forever is not a state a run can
	// be reported in. The window only has to cover a process being
	// spawned and writing one small file.
	if (lease === null) return await begun(store, runId, reviewerId, now);
	// It said so itself, which beats anything inferred about it.
	if (typeof lease.completedAt === "string") return { kind: "finished" };
	const pid = lease.supervisorPid;
	if (typeof pid !== "number" || pid <= 0) return { kind: "gone" };
	if (!facts.alive(pid)) return { kind: "gone" };

	// A lease with no readable timestamp says nothing about staleness,
	// which is not the same as saying it is stale. With a live pid and
	// no evidence either way, the answer that costs least when wrong is
	// that the supervisor is running: a collect refused can be retried,
	// and a collect taken from under a live round files every finding
	// twice.
	const beat = Date.parse(lease.updatedAt ?? "");
	const sinceMs = Number.isNaN(beat) ? 0 : now - beat;

	const recorded = lease.supervisorStartedAt;
	if (typeof recorded === "number") {
		const observed = await facts.startedAt(pid);
		if (observed !== undefined) {
			return sameProcess(observed, recorded)
				? { kind: "running", pid, sinceMs }
				: { kind: "gone" };
		}
	}
	return sinceMs > HEARTBEAT_STALE_MS
		? { kind: "gone" }
		: { kind: "running", pid, sinceMs };
}

/**
 * Where a run with no lease stands, by how long it has had none.
 *
 * Its own function because the answer is about the directory rather
 * than about the lease, and the caller above reads only leases.
 */
async function begun(
	store: ReviewerArtifactsStore,
	runId: string,
	reviewerId: string,
	now: number,
): Promise<SupervisorStanding> {
	const { reviewerDir } = store.paths(runId, reviewerId);
	try {
		const { birthtimeMs, mtimeMs } = await stat(reviewerDir);
		// Whichever the platform actually fills in. Birth time is the
		// honest one and is not reported everywhere; modification time is
		// never earlier than it for a directory nothing writes to twice.
		const since = birthtimeMs > 0 ? birthtimeMs : mtimeMs;
		return now - since < STARTING_FOR_MS
			? { kind: "starting" }
			: { kind: "gone" };
	} catch {
		// No directory either, so there is nothing here that could be
		// starting.
		return { kind: "gone" };
	}
}

/**
 * How long a run may have no lease before it is presumed dead.
 *
 * The gap is a process spawning and writing one small file. Minutes
 * rather than seconds because a machine under load can take a while
 * to get a doubly nested node process going, and the cost of waiting
 * is a run reported as starting when it is not.
 */
export const STARTING_FOR_MS = 5 * 60 * 1000;
