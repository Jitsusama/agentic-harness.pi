/**
 * The Nix daemon's builds giving way while a deploy's stamp runs.
 *
 * A stamp is the whole suite every production deploy of Acceluary and
 * Estuary waits on, and the queue gives it the first turn and the timed
 * slice. That isn't enough: jobs, the timed slice's parent, is an idle
 * group, so it only gets what nothing outside it wants, and the daemon's
 * builds in build.slice want everything. On 8 November, stamps beside
 * 9 to 14 builds ran 10 to 14 minutes, against 3 to 5 on a calm machine
 * (N3Q98W). So while a stamp runs, the session keeping the queue lowers
 * build.slice's processor weight to {@link YIELD_WEIGHT}, and puts back
 * what it was once no stamp runs. The machine lets its administrators
 * set that slice's properties without a password for this kind of change
 * (core.nix's work-slices.rules), and the change is made for this boot
 * only.
 *
 * A VM's guest keeps time by its share of the processor, and a starved
 * one fails its test's timeouts, so nothing is lowered while a VM runs
 * in build.slice or machine.slice, or the queue runs a VM job: a slow
 * stamp is put before a failed VM test, not after it.
 *
 * Acceluary's timed runs, paired timings of 3 to 16 minutes run one at a
 * time through its `tools/timed.mjs`, were given back while builds held
 * the machine's load at 25 to 55 (E2ZIAQ, 8 November), so builds yield to
 * them too, on narrower terms than a stamp's (80ECO2, WJATIN): the yield
 * lapses {@link TIMED_RUN_YIELD_MS} after the run started, whatever its
 * wrapper does; the machine updating itself to main never yields to one;
 * and nor does a quest whose work goes first while its job runs here.
 *
 * The weight it found is kept in {@link YIELD_FILE} in the queue's folder
 * before the weight is lowered, so whichever session keeps the queue next
 * puts it back, even when the one that lowered it has gone. The file is
 * made exclusively and taken by a rename, so two sessions never both
 * lower it or both put it back.
 */

import { spawnSync } from "node:child_process";
import {
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "../record.ts";

/** The weight build.slice takes while a stamp runs. */
export const YIELD_WEIGHT = 1;

/** The file in the queue's folder holding the weight to put back. */
export const YIELD_FILE = "builds-yield";

/** How long systemd may take to set a property before it counts as refused. */
const SET_MS = 5_000;

/**
 * How long a timed run may hold builds back, from when it started: the
 * longest its wrapper runs, so one that outlives it can't hold them.
 */
export const TIMED_RUN_YIELD_MS = 16 * 60_000;

/** The job kinds that run a VM. */
const VM_KINDS: ReadonlySet<string> = new Set(["vm-test", "vm-check"]);

/**
 * The names a VM's processes go by, as `/proc/<pid>/comm` shows them, cut
 * to 15 characters: qemu, NixOS's test driver and systemd-nspawn.
 */
const VM_NAMES = /^(?:qemu|nixos-test-driv|systemd-nspawn)/;

/**
 * The names update-to-main's building and switching go by, as
 * `/proc/<pid>/comm` shows them: Nix's client, and the step that puts a
 * built system on. Its own server and its fetches are neither.
 */
const UPDATE_NAMES = /^(?:nix|nixos-rebuild|darwin-rebuild|switch-to-conf)/;

/** The weights of the slice builds run in, read and set. */
export interface BuildSlice {
	/** Its processor weight now, or nothing when it can't be read. */
	weight(): number | undefined;
	/** Set its processor weight for this boot, saying whether it took. */
	setWeight(weight: number): boolean;
	/** Whether a VM runs where the system's builds and machines run. */
	hasVm(): boolean;
	/** Whether the machine is building or switching to its main. */
	updatesToMain(): boolean;
}

/**
 * The system's build.slice under `cgroups`, set through systemd so the
 * change is its own for this boot, with VMs looked for there and in
 * machine.slice, and update-to-main's builds in its own service, each
 * process named by its entry in `proc`.
 */
export function systemBuildSlice(cgroups: string, proc = "/proc"): BuildSlice {
	return {
		weight() {
			try {
				const read = readFileSync(
					join(cgroups, "build.slice", "cpu.weight"),
					"utf8",
				);
				const weight = Number.parseInt(read, 10);
				return Number.isInteger(weight) ? weight : undefined;
			} catch {
				// No build.slice, or no processor controller on it.
				return undefined;
			}
		},
		setWeight(weight) {
			const set = spawnSync(
				"systemctl",
				[
					"set-property",
					"--runtime",
					"--no-ask-password",
					"build.slice",
					`CPUWeight=${weight}`,
				],
				{ stdio: "ignore", timeout: SET_MS },
			);
			return set.status === 0;
		},
		hasVm: () =>
			vmRunsUnder(
				[join(cgroups, "build.slice"), join(cgroups, "machine.slice")],
				proc,
			),
		updatesToMain: () =>
			runsUnder(
				[join(cgroups, "system.slice", "update-to-main.service")],
				UPDATE_NAMES,
				proc,
			),
	};
}

/** A job the queue's record says runs now, as far as the yield reads it. */
interface Running {
	readonly kind: string;
	readonly quest?: string;
	readonly started?: number;
	readonly sent: boolean;
}

/** What the queue's record says runs now. */
function runningJobs(record: unknown): readonly Running[] {
	if (!isRecord(record) || !Array.isArray(record.jobs)) return [];
	return record.jobs.flatMap((job): Running[] => {
		if (!isRecord(job) || job.state !== "running") return [];
		if (typeof job.kind !== "string") return [];
		const started =
			typeof job.started === "string" ? Date.parse(job.started) : Number.NaN;
		return [
			{
				kind: job.kind,
				quest: typeof job.quest === "string" ? job.quest : undefined,
				started: Number.isNaN(started) ? undefined : started,
				sent: job.sent === true,
			},
		];
	});
}

/** What else the yield weighs, beside the queue's record and the slices. */
export interface YieldContext {
	/** The quests whose work goes first (folder.ts's `questsFirstIn`). */
	readonly first?: ReadonlySet<string>;
	/** The time now, in milliseconds. */
	readonly now?: number;
}

/**
 * Whether builds should give way now: a stamp runs, or a timed run inside
 * its {@link TIMED_RUN_YIELD_MS}, and no VM does, by the queue's record or
 * in the slices. A timed run alone yields nothing while the machine
 * updates to main, or while a job of a quest whose work goes first runs
 * on this machine.
 */
export function buildsShouldYield(
	record: unknown,
	slice: Pick<BuildSlice, "hasVm" | "updatesToMain">,
	{ first = new Set<string>(), now = Date.now() }: YieldContext = {},
): boolean {
	const jobs = runningJobs(record);
	const stamp = jobs.some((job) => job.kind === "stamp");
	const timed = jobs.some(
		(job) =>
			job.kind === "timed-run" &&
			job.started !== undefined &&
			now - job.started < TIMED_RUN_YIELD_MS,
	);
	if (!stamp && !timed) return false;
	if (jobs.some((job) => VM_KINDS.has(job.kind))) return false;
	if (slice.hasVm()) return false;
	if (stamp) return true;
	// The timed run's own quest may go first too; it is the run, not a
	// build kept from it.
	const firstRunsHere = jobs.some(
		(job) =>
			job.kind !== "timed-run" &&
			job.quest !== undefined &&
			first.has(job.quest) &&
			!job.sent,
	);
	return !firstRunsHere && !slice.updatesToMain();
}

/** What keeping the yield did, if anything. */
export type YieldChange = "lowered" | "restored";

/**
 * Lower build.slice's weight when builds should yield and nothing has, or
 * put back the weight kept in `dir` once they needn't. A weight already at
 * or below {@link YIELD_WEIGHT} is left as it is, since there is nothing
 * to give.
 */
export function keepYield(
	dir: string,
	yielding: boolean,
	slice: BuildSlice,
): YieldChange | undefined {
	const file = join(dir, YIELD_FILE);
	if (yielding) {
		const was = slice.weight();
		if (was === undefined || was <= YIELD_WEIGHT) return undefined;
		try {
			writeFileSync(file, `${was}\n`, { flag: "wx" });
		} catch {
			// Another session lowered it first, or the folder is gone.
			return undefined;
		}
		if (slice.setWeight(YIELD_WEIGHT)) return "lowered";
		rmSync(file, { force: true });
		return undefined;
	}
	const taken = `${file}.${process.pid}`;
	try {
		renameSync(file, taken);
	} catch {
		// Nothing was lowered, or another session is putting it back.
		return undefined;
	}
	const was = Number.parseInt(readFileSync(taken, "utf8"), 10);
	if (!Number.isInteger(was) || was <= 0) {
		rmSync(taken, { force: true });
		return undefined;
	}
	if (!slice.setWeight(was)) {
		renameSync(taken, file);
		return undefined;
	}
	rmSync(taken, { force: true });
	return "restored";
}

/**
 * Whether a VM's process runs in any cgroup under `roots`, by its name in
 * `proc`. A cgroup or process that goes while it is read is passed over.
 */
export function vmRunsUnder(roots: readonly string[], proc = "/proc"): boolean {
	return runsUnder(roots, VM_NAMES, proc);
}

/**
 * Whether a process whose name `names` matches runs in any cgroup under
 * `roots`, by its name in `proc`. A cgroup or process that goes while it
 * is read is passed over.
 */
function runsUnder(
	roots: readonly string[],
	names: RegExp,
	proc = "/proc",
): boolean {
	const walk = (dir: string): boolean => {
		const named = (pid: string) => names.test(commOf(proc, pid));
		if (procsIn(dir).some(named)) return true;
		return childrenOf(dir).some((child) => walk(join(dir, child)));
	};
	return roots.some(walk);
}

function childrenOf(dir: string): readonly string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		// A cgroup gone with its build holds no VM.
		return [];
	}
}

function procsIn(dir: string): readonly string[] {
	try {
		return readFileSync(join(dir, "cgroup.procs"), "utf8")
			.split("\n")
			.filter((pid) => pid !== "");
	} catch {
		// A cgroup gone since it was listed holds nothing.
		return [];
	}
}

function commOf(proc: string, pid: string): string {
	try {
		return readFileSync(join(proc, pid, "comm"), "utf8").trim();
	} catch {
		// A process gone since it was listed was no VM.
		return "";
	}
}
