/**
 * The machine's queue: heavy work takes turns by the room it needs.
 *
 * Every pi session on the machine shares one queue, kept as files in
 * the account's runtime directory (see folder.ts), with no daemon and
 * nobody in charge: whichever session looks next starts the next job.
 * An agent learns nothing new. Its bash call runs as it always did; the
 * harness reads what kind of work the command is from one map, so no
 * agent names its own place, and the command's shell waits for its
 * turn before it starts. pi itself never waits, only the shell does.
 *
 * What a turn is decided by:
 *
 * - **Memory**, the one hard limit: CPU is shared by weight, so an idle
 *   build only takes what nobody else wants, but memory past what the
 *   machine has is what systemd-oomd ends work for. A job starts when
 *   the memory left past the floors core.nix keeps for Joel's programs
 *   covers what its kind needs, and pressure is under a set point.
 * - **Kinds held to a number at once**: VMs, whose tests time out when
 *   they share the CPU with too much else.
 * - **Order**: timed work before bulk, then the oldest first. A job its
 *   limit holds back lets the next one past; a job memory holds back
 *   holds everyone behind it, so a big job is never starved by small
 *   ones slipping in.
 * - **One at a time, a little apart**: memory is read a moment after
 *   it is taken, and everyone reacting at once to one reading is what
 *   makes a group overshoot and swing back, so turns are given out one
 *   at a time, a few seconds apart, with what was just started counted
 *   as taken until it has had time to grow.
 */

/** What a command does, as the harness reads it. */
export type Kind = "vm-test" | "vm-check" | "benchmark" | "build";

/**
 * How a kind is run: timed work's result depends on its timing, so it
 * runs at a weight of its own; bulk takes whatever is left.
 */
export type Class = "timed" | "bulk";

export const CLASS_OF: Readonly<Record<Kind, Class>> = {
	// A VM test run from its driver, in the session's own cgroups.
	"vm-test": "timed",
	// A VM test run by the Nix daemon, as `nix build` of a check does: it
	// runs in build.slice whatever the queue says, so it is bulk here,
	// but it is a VM all the same and counts against the VMs at once.
	"vm-check": "bulk",
	benchmark: "timed",
	build: "bulk",
};

/**
 * The memory each kind is held to need, in GiB. 2HN63P's VM tests take
 * 2 to 6 GiB each, so a VM is given the top of that. A build's and a
 * benchmark's are starting values, not yet measured.
 */
export const NEEDS_GIB: Readonly<Record<Kind, number>> = {
	"vm-test": 6,
	"vm-check": 6,
	benchmark: 2,
	build: 4,
};

/**
 * How many VMs run at once. 2HN63P's run 1 to 4 vCPUs each and kvm
 * takes several together; they ran one at a time across the machine
 * only because their timeouts flaked beside each other and big builds.
 */
export const MOST_VMS = 2;

/** Memory pressure (avg10, percent) past which no job starts. */
export const MOST_MEMORY_PRESSURE = 10;

/** How far apart two turns are given. */
export const SPREAD_MS = 3_000;

/** How long a started job's need counts as taken, while it grows. */
export const RAMP_MS = 60_000;

/** One piece of heavy work, waiting for its turn or running. */
export interface Job {
	readonly id: string;
	readonly kind: Kind;
	/** The step that does the heavy work, as one line. */
	readonly what: string;
	/** The pi session that started it, and pi's pid. */
	readonly owner: { readonly session: string; readonly pid: number };
	/** When it asked for its turn. */
	readonly since: string;
	/** When it was given its turn, once it has one. */
	readonly started?: string;
}

/** What the machine has left, as the queue reads it. */
export interface Room {
	/** Memory available past the floors, in GiB. */
	readonly availableGib: number;
	/** Memory pressure, avg10, in percent. */
	readonly memoryPressure: number;
}

const VMS: ReadonlySet<Kind> = new Set(["vm-test", "vm-check"]);

/** Whether a job holds a VM. */
export function isVm(job: Pick<Job, "kind">): boolean {
	return VMS.has(job.kind);
}

/** The jobs waiting, in the order they get their turns. */
export function waitingInOrder(jobs: readonly Job[]): Job[] {
	return jobs
		.filter((job) => job.started === undefined)
		.sort(
			(one, other) =>
				rank(one) - rank(other) ||
				Date.parse(one.since) - Date.parse(other.since) ||
				one.id.localeCompare(other.id),
		);
}

const rank = (job: Job) => (CLASS_OF[job.kind] === "timed" ? 0 : 1);

/**
 * The job to start now, if any: the first waiting in order that its
 * kind's limit and the memory left both let in. Nothing within
 * {@link SPREAD_MS} of the last turn given.
 */
export function nextTurn(
	jobs: readonly Job[],
	room: Room,
	now: number,
): Job | undefined {
	const running = jobs.filter((job) => job.started !== undefined);
	const last = Math.max(
		-Infinity,
		...running.map((job) => Date.parse(job.started as string)),
	);
	if (now - last < SPREAD_MS) return undefined;
	if (room.memoryPressure >= MOST_MEMORY_PRESSURE) return undefined;
	const growing = running
		.filter((job) => now - Date.parse(job.started as string) < RAMP_MS)
		.reduce((sum, job) => sum + NEEDS_GIB[job.kind], 0);
	const vms = running.filter(isVm).length;
	for (const job of waitingInOrder(jobs)) {
		if (isVm(job) && vms >= MOST_VMS) continue;
		if (room.availableGib - growing < NEEDS_GIB[job.kind]) return undefined;
		return job;
	}
	return undefined;
}

/**
 * Whether a job is waiting though the memory it needs is free: held by
 * a limit, not by room. A minute this holds is a wasted minute, the
 * number the queue's limits are tuned to bring to nothing.
 */
export function waitsWithRoom(jobs: readonly Job[], room: Room): boolean {
	return (
		room.memoryPressure < MOST_MEMORY_PRESSURE &&
		waitingInOrder(jobs).some((job) => NEEDS_GIB[job.kind] <= room.availableGib)
	);
}

/** A heredoc's body, from the line after `<<WORD` to WORD alone. */
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;

/** A quoted string: single quotes, or double with its escapes. */
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;

/** Where a shell command's steps end. */
const STEPS = /\n|;|&&|\|\|/;

/**
 * The one map from a command to its kind, first match winning. A VM
 * test is a VM or a test driver run here; building a test's driver is a
 * build; a VM check is a Nix build or check of something named for a
 * VM test, which the daemon runs.
 */
const KINDS: readonly (readonly [RegExp, Kind])[] = [
	[
		/\bqemu-system-[\w-]+\b|\bqemu-kvm\b|\bnixos-test-driver\b|\/bin\/run-[\w-]+-vm\b/,
		"vm-test",
	],
	[/\bnix\s+build\b[^\n]*\.driver\b/, "build"],
	[
		/\bnix(?:\s+--?\S+)*\s+(?:build|flake\s+check)\b[^\n]*(?:\bvm-|\.vm\b|nixosTests|vmTest)/,
		"vm-check",
	],
	[/\bcargo\s+bench\b|\bhyperfine\b/, "benchmark"],
	[
		/\bnix\s+flake\s+check\b|\bnix\s+build\b|\bnix-build\b|\bnixos-rebuild\b|\bcargo\s+(?:build|check|clippy|test|nextest|run|install)\b/,
		"build",
	],
];

/**
 * The kind of heavy work a command runs, read only where the shell runs
 * it: text in quotes or a heredoc names work rather than running it.
 * Nothing for a command that runs none.
 */
export function kindOf(command: string): Kind | undefined {
	const runs = command.replace(HEREDOC, "\n").replace(QUOTED, "''");
	return KINDS.find(([pattern]) => pattern.test(runs))?.[1];
}

/** Variables set at the start of a step, as `A=1 B="two" cmd` sets two. */
const ASSIGNMENTS =
	/^\s*(?:export\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)(?:\s+|$))+/;

/** The step of a command that does its heavy work, as one line. */
export function whatOf(command: string): string {
	const steps = command
		.split(STEPS)
		.map((step) => step.replace(ASSIGNMENTS, "").trim())
		.filter((step) => step !== "");
	const step = steps.find((one) => kindOf(one) !== undefined) ?? steps[0] ?? "";
	return step.length > 120 ? `${step.slice(0, 117)}...` : step;
}
