/**
 * Asking the machine about a process, and saying which one you meant.
 *
 * Its own module for the reason `lib/exec` and `lib/clock` are. Two
 * domains need this and neither owns it: `lib/subagent` asks whether
 * the supervisor holding a reviewer's lease is still there, and
 * `lib/work` asks whether the session holding a worktree is. They are
 * the same question, and the second was about to be answered by a
 * second copy of the first.
 *
 * A pid identifies nothing on its own, which is why the start time
 * travels with it everywhere here. Pids are reused, and the reuse is
 * not rare on a machine that spawns a supervisor per reviewer: acting
 * on a bare pid means signalling, or reclaiming from, whatever process
 * happens to be wearing that number now.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * How far apart two readings of one process's start time may be.
 *
 * `ps` reports whole seconds and the recorded value has millisecond
 * precision, so the same process reads differently depending on which
 * side of a second each observation landed on.
 */
export const SAME_PROCESS_MS = 2_000;

/**
 * How long to wait for the process table.
 *
 * This runs inside walks over every reviewer directory and every
 * remembered tree, so an unbounded probe against a wedged process
 * table stalls a session's startup rather than one item's recovery.
 */
const PS_TIMEOUT_MS = 2_000;

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
 * Which process wrote something down.
 *
 * Both fields or neither. A pid on its own cannot be checked against
 * anything later, so a record carrying one is a record that reads as
 * whoever holds that number next.
 */
export interface Owner {
	pid: number;
	startedAt: number;
}

/**
 * Whether two observations describe the same process.
 *
 * Two-sided on purpose. Only refusing the later ones would let a pid
 * that has been around far longer than our child pass: a record
 * holding a garbage or truncated pid can name `1`, and `1` started at
 * boot, which is emphatically earlier. Signalling that process group
 * is not a mistake anybody gets to make twice.
 */
export function sameProcess(observed: number, recorded: number): boolean {
	return Math.abs(observed - recorded) <= SAME_PROCESS_MS;
}

/** Whether a value read off disk says enough to identify a process. */
export function isOwner(said: unknown): said is Owner {
	if (said === null || typeof said !== "object") return false;
	const owner = said as Partial<Owner>;
	return (
		typeof owner.pid === "number" &&
		owner.pid > 0 &&
		typeof owner.startedAt === "number"
	);
}

/**
 * Who this process is, for writing down.
 *
 * Returns nothing when the machine will not say when we started,
 * because half an identity is worse than none: a record carrying a
 * pid and no start time is one a later reader must either trust
 * blindly or discard, and both of those are decisions this can avoid
 * forcing by declining to write it.
 */
export async function ownerNow(
	facts: ProcessFacts = systemFacts,
	pid: number = process.pid,
): Promise<Owner | undefined> {
	const startedAt = await facts.startedAt(pid);
	return startedAt === undefined ? undefined : { pid, startedAt };
}

/**
 * Whether the process that wrote a record is still the one running.
 *
 * Identity outranks liveness in both directions. A live pid whose
 * start time disagrees is a stranger wearing the number, and is gone
 * for our purposes; there is no case where a mismatch means present.
 *
 * Undecidable when the machine will not answer, which is deliberately
 * distinct from absent: a caller reclaiming things must treat "cannot
 * tell" as "still there", and a caller merely reporting need not.
 */
export async function ownerStanding(
	owner: Owner,
	facts: ProcessFacts = systemFacts,
): Promise<"running" | "gone" | "unknown"> {
	if (!facts.alive(owner.pid)) return "gone";
	const startedAt = await facts.startedAt(owner.pid);
	// Alive, but the table will not say since when. Nothing here can
	// tell our process from a stranger holding the number, and the
	// answer that costs work is the confident one.
	if (startedAt === undefined) return "unknown";
	return sameProcess(startedAt, owner.startedAt) ? "running" : "gone";
}

/** What the machine itself says, which is what everything but a test uses. */
export const systemFacts: ProcessFacts = {
	async startedAt(pid) {
		try {
			// `lstart` rather than `etime`, because elapsed time is
			// relative to now and the comparison wants an absolute
			// moment. LC_ALL is pinned because the output is a formatted
			// date: under a locale Date.parse cannot read, every identity
			// check would decline and every caller would fall back to its
			// own worst branch without saying anything.
			const { stdout } = await promisify(execFile)(
				"ps",
				["-o", "lstart=", "-p", String(pid)],
				{ timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } },
			);
			const parsed = Date.parse(stdout.trim());
			return Number.isNaN(parsed) ? undefined : parsed;
		} catch {
			// No such process, no ps, or a process table too wedged to
			// answer in time. Nothing here knows what it would be talking
			// about, and saying so is the safe answer.
			return undefined;
		}
	},
	alive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			// No such process, or one we may not signal. Either way it is
			// not ours.
			return false;
		}
	},
};
