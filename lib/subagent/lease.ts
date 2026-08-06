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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReviewerArtifactsStore } from "./artifacts.js";

/**
 * How far apart two observations of one process's birth may be.
 *
 * The supervisor stamps its own clock; the operating system stamped
 * its own a moment earlier, and reports it to the second. Two seconds
 * is scheduling noise. A recycled pid is minutes or hours away, never
 * this.
 */
export const SAME_PROCESS_MS = 2_000;

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
 * Asking the machine about a process.
 *
 * Injected because it is the one part of this that cannot be decided
 * from a file, and because a test that exercises it for real is a test
 * that kills something by a number it read off disk.
 */
export interface ProcessFacts {
	/** When this process started, or undefined when nothing can say. */
	startedAt(pid: number): Promise<number | undefined>;
	/** Whether anything is wearing this pid at all. */
	alive(pid: number): boolean;
}

/**
 * Whether two observations describe the same process.
 *
 * Two-sided on purpose. Only refusing the later ones would let a pid
 * that has been around far longer than our child pass: a lease holding
 * a garbage or truncated pid can name `1`, and `1` started at boot,
 * which is emphatically earlier. Signalling that process group is not
 * a mistake anybody gets to make twice.
 */
export function sameProcess(observed: number, recorded: number): boolean {
	return Math.abs(observed - recorded) <= SAME_PROCESS_MS;
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
	if (lease === null) return { kind: "gone" };
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

/** Asking the operating system, which is what the real thing must do. */
export const systemFacts: ProcessFacts = {
	async startedAt(pid) {
		try {
			// `lstart` rather than `etime`, because elapsed time is
			// relative to now and the comparison wants an absolute
			// moment. LC_ALL is pinned because the output is a formatted
			// date: under a locale Date.parse cannot read, every identity
			// check would decline and the reaper would turn itself off
			// without saying anything.
			const { stdout } = await promisify(execFile)(
				"ps",
				["-o", "lstart=", "-p", String(pid)],
				{ timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } },
			);
			const parsed = Date.parse(stdout.trim());
			return Number.isNaN(parsed) ? undefined : parsed;
		} catch {
			// No such process, no ps, or a process table too wedged to
			// answer in time. Nothing here knows what it would be
			// talking about, and saying so is the safe answer.
			return undefined;
		}
	},
	alive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			// No such process, or one we may not signal. Either way it is
			// not a supervisor of ours.
			return false;
		}
	},
};

/**
 * How long to wait for the process table.
 *
 * Startup recovery walks every reviewer directory and this runs inside
 * that walk, so an unbounded probe against a wedged process table
 * stalls a session's startup rather than one reviewer's recovery.
 */
const PS_TIMEOUT_MS = 2_000;
