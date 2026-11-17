/**
 * The queue's words: a job as its file holds it, the machine's room as a
 * keep reads it, the rules a keep goes by, and why a job waits.
 */

import type { Kind, Walk } from "./needs.ts";
import type { Beside } from "./outcome.ts";

/** One piece of heavy work, waiting for its turn or running. */
export interface Job {
	readonly id: string;
	readonly kind: Kind;
	/** The step that does the heavy work, as one line. */
	readonly what: string;
	/**
	 * The memory it was judged to need as it asked, in GiB, from its whole
	 * step: `what` is cut short, and a long flake reference such as
	 * `git+file://$PWD?rev=<commit>` once cut off the `#checks` that said a
	 * job evaluates every check, holding it to a build's 4.
	 */
	readonly needsGib?: number;
	/**
	 * How long the same work took the last time it ran, in seconds, as it
	 * asked (outcome.ts's `ranSAfter`): when the memory it holds is due
	 * back once it runs, and whether it would still run by then while it
	 * waits (see next-turn.ts's `lineKept`). Nothing for work not yet
	 * seen.
	 */
	readonly lastRanS?: number;
	/** The pi session that started it, and pi's pid. */
	readonly owner: { readonly session: string; readonly pid: number };
	/** When it asked for its turn. */
	readonly since: string;
	/** When it was given its turn, once it has one. */
	readonly started?: string;
	/** What a walk of World's objects does, read from its whole command. */
	readonly walk?: Walk;
	/**
	 * It sends its whole run to a builder elsewhere, as a committed
	 * changed-checks or a `nix-offload there --here-when-idle` does
	 * (send.ts's `sendsWholeRun`), so this machine's
	 * CPU holds it not.
	 */
	readonly sent?: true;
	/**
	 * Its fetch of World's main was answered by one that had just made it
	 * (fetched.ts): given its turn past the walks at once, it walks nothing.
	 */
	readonly answered?: true;
	/** Given its turn beside a VM check, with its Nix builds capped. */
	readonly capped?: boolean;
	/**
	 * Whether its shell caps its builds when told to. A shell an older
	 * harness started waits without reading the cap, so its build beside a
	 * VM check would run on every core; it waits for the check instead.
	 */
	readonly cappable?: boolean;
	/** The most that ran beside it at once, while it runs. */
	readonly beside?: Beside;
	/**
	 * A Nix build it asked for ran a VM or another check with deadlines,
	 * seen while it runs, so the next time it is asked for it waits as one.
	 */
	readonly ranTimed?: true;
	/**
	 * The most memory its Nix builds held at once, in bytes: up to, since
	 * it adds each build's own peak, and those need not have met.
	 */
	readonly buildsPeakBytes?: number;
	/**
	 * The most memory its own commands held, in bytes, from its shell's
	 * scope: the `nix` client's evaluation, cargo, or a VM test run from
	 * its driver, none of which is a Nix build's. Read only while that
	 * scope holds nothing but its shell's work (room.ts's
	 * `ownedMemoryPeakOf`); `ownPeakBytes`, which an older harness wrote,
	 * could hold a scope every job shared, so nothing reads it.
	 */
	readonly ownedPeakBytes?: number;
	/**
	 * A build its last run, or failing one what it builds, says takes
	 * seconds (outcome.ts's `quickAfter`): it goes ahead of other bulk
	 * work, past a job held back, and has a turn of its own beside a VM
	 * check, at bounds.ts's `QUICK_NIX`.
	 */
	readonly quick?: true;
	/**
	 * The quest its session had loaded as it asked, from the `PI_QUEST`
	 * its commands carry, so a quest marked `queue: first` goes ahead.
	 */
	readonly quest?: string;
	/**
	 * Its shell is asking Nix what it will build (plan.ts), so it has no
	 * place in line until the plan is read or plan.ts's `PLAN_MS` passes.
	 */
	readonly planning?: true;
	/** What its plan made it, or that the plan said nothing. */
	readonly planned?: "vm-check" | "build" | "failed";
	/** Why its plan said nothing, when it didn't. */
	readonly planFailed?: string;
	/**
	 * Why it waits now, as next-turn.ts's `waitReasons` last judged it,
	 * and since when: its time asking, for the first. Kept once its turn
	 * comes, so its outcome closes the stretch there.
	 */
	readonly waitingSince?: {
		readonly reason: WaitReason;
		readonly at: string;
	};
	/** How long it waited on each reason before its current one, in ms. */
	readonly waitedOnMs?: WaitedOn;
	/**
	 * When a VM of its own was first seen running: a build with deadlines
	 * it asked Nix for, or a qemu in its own cgroup. A VM job holds a VM
	 * slot from its turn, so the time before this is a slot held while it
	 * only built.
	 */
	readonly vmSince?: string;
	/**
	 * When the memory its builds and its own commands held last rose by
	 * bounds.ts's `GREW_BYTES` or more, and to how much, in bytes.
	 */
	readonly grewAt?: string;
	readonly grewTo?: number;
}

/** Time spent waiting on each reason, those it never waited on left out. */
export type WaitedOn = Readonly<Partial<Record<WaitReason, number>>>;

/** What the machine has left, as the queue reads it. */
export interface Room {
	/** Memory available past the floors, in GiB. */
	readonly availableGib: number;
	/** Memory pressure, avg10, in percent. */
	readonly memoryPressure: number;
	/** VMs running on the machine, queued or not. */
	readonly vms: number;
	/** CPU pressure, avg10, in percent. */
	readonly cpuPressure: number;
	/**
	 * CPU pressure, avg60, in percent, which a build's hold reads beside
	 * avg10 so a dip of a few seconds doesn't let builds in. Nothing where
	 * it isn't read.
	 */
	readonly cpuPressureMinute?: number;
	/** IO pressure, the greater of avg10 and avg60, in percent, where read. */
	readonly ioPressure?: number;
	/**
	 * Memory pressure, avg10, in percent, the most any memory floor's
	 * programs feel: the person's own, as app.slice holds them. Nothing
	 * where no floor is read.
	 */
	readonly floorsPressure?: number;
	/**
	 * CPU pressure, avg10, in percent, the most any memory floor's
	 * programs feel. Nothing where no floor is read.
	 */
	readonly floorsCpuPressure?: number;
	/** A builder elsewhere Nix sends work to, while one stands. */
	readonly offload?: Offload;
	/**
	 * Since when, in epoch milliseconds, a builder elsewhere has been
	 * being lent, while none stands yet.
	 */
	readonly lendingSince?: number;
}

/**
 * The room of the builders elsewhere that Nix may send this machine's
 * builds to, from its machines file: their slots for builds, and for VM
 * checks where they can run VMs. While one stands, the queue counts its
 * slots as room of this machine's own, so work waiting here goes there.
 * Without this, the queue held that work for optimus's room alone, and
 * nothing reached the builder (5FWIUS, 29 October).
 *
 * The queue can't choose where a build runs: Nix's build hook takes a
 * free slot on a builder that matches first and otherwise builds here.
 * So no more is counted than the builder's own slots; past them, an
 * admitted build would land on this machine.
 */
export interface Offload {
	/** Slots free now for builds. */
	readonly builds: number;
	/** Of those, the slots free now on builders that run VMs. */
	readonly vms: number;
}

const VMS: ReadonlySet<Kind> = new Set(["vm-test", "vm-check"]);

/** Whether a job holds a VM. */
export function isVm(job: Pick<Job, "kind">): boolean {
	return VMS.has(job.kind);
}

/**
 * Whether a job takes the quick turn: a build marked quick whose shell
 * reads its own cap, which a shell an older harness started can't, or a
 * push of World marked quick, which it is when it leaves out its LFS
 * scan (see needs.ts's `PUSH_GIB`). A quick push still counts as a walk
 * while it runs, but waits for no other walk to end, except on a machine
 * holding walks below the usual count, where it waits for another quick
 * push (next-turn.ts).
 */
export function isQuick(job: Job): boolean {
	if (job.quick !== true || job.cappable !== true) return false;
	return (
		job.kind === "build" || (job.kind === "world-walk" && job.walk === "push")
	);
}

/**
 * How the queue gives turns beyond memory, while the machine lacks the
 * timed slice.
 */
export interface Rules {
	/**
	 * Whether builds are held back while a VM check runs. The queue gates
	 * memory, not CPU, and a VM check is the daemon's, in build.slice, so
	 * a build started beside it shares its CPU: a kernel build beside a
	 * running camera subtest is what broke its timing. Holding every build
	 * cost more than it saved: at 13:47 on 22 October one check, on two
	 * thirds of one core, held five builds for up to 24 minutes while the
	 * CPU sat 72% idle. So bounds.ts's `BUILDS_BESIDE_VMS` build at a time
	 * starts beside one while CPU pressure is under its
	 * `MOST_CPU_PRESSURE_BESIDE_VMS` and the person's own programs don't
	 * stall on memory, and the rest wait. Pressure is read seconds late,
	 * and nothing slows a daemon build once it runs, so that build is
	 * capped as it starts (see bounds.ts's `CAPPED_NIX`).
	 *
	 * A VM check still starts beside builds, but not past one waiting for
	 * its turn, so a build waits only for the checks already running:
	 * skipping it instead let a stream of 15-minute checks hold a 1-minute
	 * build at place 5 for as long as they kept coming. Off once VM tests
	 * run timed, from their drivers.
	 */
	readonly buildsWaitForVmChecks: boolean;
	/** How many VMs run at once, when not bounds.ts's `MOST_VMS`. */
	readonly mostVms?: number;
	/**
	 * How many walks of World's git objects run at once, when not
	 * needs.ts's `WALKS_AT_ONCE`.
	 */
	readonly walksAtOnce?: number;
}

/** A pressure limit the queue holds work back at, by what presses. */
export type Pressed = "memory" | "cpu";

export const RULES: Rules = { buildsWaitForVmChecks: true };

/**
 * A Mac's rules: one walk of World at a time. A Mac has no floors to
 * keep the person's programs their memory, and its kernel calls pages it
 * compressed or swapped gone, so its room reads roomy while each walk's
 * packs push the rest to swap. On 16 November equilibrius, at 48 GiB
 * with 43 sessions, had 4.7 of its 6 GiB of swap used.
 */
export const MAC_RULES: Rules = { ...RULES, walksAtOnce: 1 };

/**
 * Why a job waits: `memory`, the memory it needs isn't free; `vms`, the
 * VMs allowed at once are running; `walks`, the walks of World's objects
 * allowed at once are running; `behind`, a VM check runs and builds
 * beside one are at their limit; `order`, jobs ahead of it come first;
 * `planning`, its shell is asking Nix what it will build; `lending`, a
 * builder elsewhere is being lent and will take it; `busy`, the person's
 * programs wait on CPU, or a build waits for the machine's to fall.
 */
export type WaitReason =
	| "busy"
	| "memory"
	| "vms"
	| "walks"
	| "behind"
	| "order"
	| "planning"
	| "lending";

/** How many more VMs and builds could start now. */
export interface RoomLeft {
	readonly vms: number;
	readonly builds: number;
}
