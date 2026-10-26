/**
 * Asking the machine about a process, and saying which one you meant.
 *
 * Its own module because more than one domain needs this and neither
 * owns it: a subagent supervisor asks whether the process holding a
 * reviewer's lease is still there, and the work broker asks whether
 * the session holding a worktree is. They are the same question, and
 * the second was about to be answered by a second copy of the first.
 *
 * A pid identifies nothing on its own, which is why the start time
 * travels with it everywhere here. Pids are reused, and the reuse is
 * not rare on a machine that spawns a supervisor per reviewer: acting
 * on a bare pid means signalling, or reclaiming from, whatever process
 * happens to be wearing that number now.
 *
 * The boot travels with them where the machine will name it. Pids and
 * start times both restart their story at every boot, and the first
 * minute after one is when the most records written before it get
 * read: the pid a record names is as likely as not some fresh process
 * of this boot, started in the same second as the reader. A record
 * from another boot is decisively gone, and saying so needs no look at
 * the process table at all.
 */

import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
	/**
	 * Which boot of the machine this is, or undefined where it will not
	 * say. Optional, so a machine that cannot name its boot is judged
	 * exactly as before rather than wrongly.
	 */
	bootId?(): string | undefined;
}

/**
 * Which process wrote something down.
 *
 * Both fields or neither. A pid on its own cannot be checked against
 * anything later, so a record carrying one is a record that reads as
 * whoever holds that number next.
 *
 * The boot is optional, because records written before it was kept
 * are still on disk and still name somebody, and because not every
 * machine will say which boot it is on.
 */
export interface Owner {
	pid: number;
	startedAt: number;
	bootId?: string;
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
		typeof owner.startedAt === "number" &&
		(owner.bootId === undefined || typeof owner.bootId === "string")
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
	if (startedAt === undefined) return undefined;
	const bootId = facts.bootId?.();
	return bootId === undefined ? { pid, startedAt } : { pid, startedAt, bootId };
}

/**
 * Whether the process that wrote a record is still the one running.
 *
 * Identity outranks liveness in both directions. A live pid whose
 * start time disagrees is a stranger wearing the number, and is gone
 * for our purposes; there is no case where a mismatch means present.
 *
 * A record from another boot is gone before anything is asked: no
 * process outlives the boot it started in, and asking would only give
 * a fresh process wearing the number the chance to answer for it.
 *
 * Undecidable only when the pid is alive and the machine will not say
 * since when, which is deliberately distinct from absent: a caller
 * reclaiming things must treat "cannot tell" as "still there", and a
 * caller merely reporting need not. A start time that will not read
 * because the process has just exited is not that case, so the pid is
 * looked at again before the answer settles on it.
 */
export async function ownerStanding(
	owner: Owner,
	facts: ProcessFacts = systemFacts,
): Promise<"running" | "gone" | "unknown"> {
	if (owner.bootId !== undefined) {
		const now = facts.bootId?.();
		if (now !== undefined && now !== owner.bootId) return "gone";
	}
	if (!facts.alive(owner.pid)) return "gone";
	const startedAt = await facts.startedAt(owner.pid);
	if (startedAt === undefined) {
		// Alive a moment ago, and the table will not say since when. A
		// short-lived process that exited in between reads exactly like
		// this, and it is gone, so look again. Still alive and still
		// unreadable is the one case nothing here can tell from a
		// stranger holding the number, and the answer that costs work is
		// the confident one.
		return facts.alive(owner.pid) ? "unknown" : "gone";
	}
	return sameProcess(startedAt, owner.startedAt) ? "running" : "gone";
}

/**
 * Facts about processes, asked once each however often they are wanted.
 *
 * The cache holds what the machine said, never what a caller concluded
 * from it. A standing is a judgement about one record, since it
 * compares the pid's real start time against the one that record
 * wrote down, so caching a standing under a pid lets one stale record
 * answer for a live session that happens to be wearing the same
 * number. The fact is per-pid and safe to share; the verdict is not,
 * and this exists because the verdict was cached twice.
 */
export function askedOnce(facts: ProcessFacts): ProcessFacts {
	const startedAt = new Map<number, Promise<number | undefined>>();
	const bootId = facts.bootId?.bind(facts);
	return {
		alive: (pid) => facts.alive(pid),
		...(bootId === undefined ? {} : { bootId }),
		startedAt: (pid) => {
			const already = startedAt.get(pid);
			if (already !== undefined) return already;
			const answer = facts.startedAt(pid);
			startedAt.set(pid, answer);
			return answer;
		},
	};
}

/** What the machine itself says, which is what everything but a test uses. */
export const systemFacts: ProcessFacts = {
	async startedAt(pid) {
		if (process.platform === "linux") return startedAtFromProc(pid);
		return startedAtFromPs(pid);
	},
	bootId: () => {
		bootOnce ??= { id: readBootId() };
		return bootOnce.id;
	},
	alive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			// EPERM means a process is there and is not ours to signal,
			// which is emphatically alive. Collapsing it into "gone" was
			// safe reasoning for a supervisor we spawned ourselves, since
			// one we may not signal cannot be ours; it is not safe for a
			// worktree, where the holder can be another user's session and
			// the penalty for guessing is deleting their work.
			if ((error as NodeJS.ErrnoException)?.code === "EPERM") return true;
			return false;
		}
	},
};

/** The boot, asked once per process, since it cannot change under us. */
let bootOnce: { id: string | undefined } | undefined;

/**
 * The machine's name for this boot.
 *
 * Linux keeps a fresh random one per boot under /proc, and macOS a
 * session UUID behind sysctl. Anywhere else, and wherever either will
 * not answer, there is none, and every judgement falls back to the
 * pid and start time alone, as it always did.
 */
function readBootId(): string | undefined {
	try {
		if (process.platform === "linux") {
			return (
				readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() ||
				undefined
			);
		}
		if (process.platform === "darwin") {
			return (
				execFileSync("sysctl", ["-n", "kern.bootsessionuuid"], {
					encoding: "utf8",
					timeout: PS_TIMEOUT_MS,
				}).trim() || undefined
			);
		}
	} catch {
		// Nothing to name the boot by, which is a machine judged on pid
		// and start time alone rather than a reason to fail.
	}
	return undefined;
}

/**
 * Clock ticks per second, which /proc counts a start time in.
 *
 * Asked of getconf once. It is 100 on every Linux anybody runs, which
 * is the answer when getconf will not give one.
 */
let ticksOnce: Promise<number> | undefined;
function ticksPerSecond(): Promise<number> {
	ticksOnce ??= promisify(execFile)("getconf", ["CLK_TCK"], {
		timeout: PS_TIMEOUT_MS,
	}).then(
		({ stdout }) => {
			const ticks = Number(stdout.trim());
			return Number.isInteger(ticks) && ticks > 0 ? ticks : 100;
		},
		() => 100,
	);
	return ticksOnce;
}

/**
 * When a process started, read from the kernel's own account of it.
 *
 * A file read rather than a subprocess, so it cannot time out when
 * five sessions start in the same second after a boot, which is when
 * `ps` did. The same arithmetic `ps` does for `lstart`, the boot time
 * plus the start in ticks, so a value recorded through `ps` before
 * this agrees with it to well inside SAME_PROCESS_MS. A missing file
 * is a process that is not there, and says nothing.
 */
async function startedAtFromProc(pid: number): Promise<number | undefined> {
	try {
		const [stat, system, ticks] = await Promise.all([
			readFile(`/proc/${pid}/stat`, "utf8"),
			readFile("/proc/stat", "utf8"),
			ticksPerSecond(),
		]);
		// The command name sits in parentheses and may hold anything,
		// parentheses and spaces included, so the fields are counted
		// from the last closing one. Field 3, the state, comes first
		// after it, which puts field 22, the start time, at index 19.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const startTicks = Number(fields[19]);
		const bootSeconds = Number(/^btime (\d+)$/m.exec(system)?.[1]);
		if (!Number.isFinite(startTicks) || !Number.isFinite(bootSeconds)) {
			return undefined;
		}
		return Math.round(bootSeconds * 1000 + (startTicks * 1000) / ticks);
	} catch {
		return undefined;
	}
}

/** When a process started, by asking `ps`, where there is no /proc. */
async function startedAtFromPs(pid: number): Promise<number | undefined> {
	try {
		// `lstart` rather than `etime`, because elapsed time is relative
		// to now and the comparison wants an absolute moment. LC_ALL is
		// pinned because the output is a formatted date: under a locale
		// Date.parse cannot read, every identity check would decline and
		// every caller would fall back to its own worst branch without
		// saying anything.
		const { stdout } = await promisify(execFile)(
			"ps",
			["-o", "lstart=", "-p", String(pid)],
			{ timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } },
		);
		const parsed = Date.parse(stdout.trim());
		return Number.isNaN(parsed) ? undefined : parsed;
	} catch {
		// No such process, no ps, or a process table too wedged to answer
		// in time. Nothing here knows what it would be talking about, and
		// saying so is the safe answer.
		return undefined;
	}
}
