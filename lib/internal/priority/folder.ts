/**
 * Where the machine's queue is kept: one folder in the account's
 * runtime directory (`$XDG_RUNTIME_DIR/jobs`), shared by every pi
 * session and read by the launcher.
 *
 * - `<id>.job`: a job, written by the session that asked for it.
 * - `<id>.pid`: the pid of the shell waiting to run it, written by the
 *   shell itself, so the job ends when that shell does, however it
 *   ends: finished, stopped or killed.
 * - `<id>.turn`: its turn, given by whichever session kept the queue
 *   last. It holds the cgroup the shell moves into before it runs the
 *   work, or nothing to stay where it is.
 * - `queue.json`: the whole queue as one record, for the launcher and
 *   the mesh. Each write replaces it whole, so a watch on the folder
 *   hears every change, and it carries a heartbeat in epoch seconds, so
 *   a reader can tell a queue nobody keeps any more.
 * - `<id>.capped`: given beside a VM check, so the shell runs the work
 *   with the Nix settings it holds, first in `NIX_USER_CONF_FILES`: a
 *   quick job's {@link QUICK_NIX}, or else {@link CAPPED_NIX}, which
 *   `capped.conf` holds too for a shell an older harness started.
 * - `<id>.began`: written by its shell as the work begins, after the
 *   wait, so its time limit can start there (clock.ts).
 * - `<id>.end`: its shell's exit status, written as the shell exits,
 *   which goes with the job into the outcome file when it is given up.
 * - `room`: the room left, as words ("2 VM tests and 8 builds more"),
 *   or nothing, written with queue.json, which a shell says when its
 *   work ends.
 *
 * Keeping the queue is done under a lock any session may take, so two
 * sessions never give one turn twice. A lock older than a few seconds
 * belongs to a session that died holding it, and is taken over.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { awaitedNow, NOBODY } from "./awaited.ts";
import { workNameIn } from "./name.ts";
import {
	besideNow,
	capFor,
	keepOutcome,
	kindAfter,
	mostBeside,
	NOTHING_BESIDE,
	type Outcome,
	outcomeOf,
	outcomesIn,
	peakGibAfter,
	quickAfter,
	ranSAfter,
	vmsFor,
} from "./outcome.ts";
import {
	CLASS_OF,
	type Class,
	type Job,
	type Kind,
	needsGibOf,
	nextTurn,
	QUICK_NIX,
	type RoomLeft,
	RULES,
	type Rules,
	roomLeft,
	roomSaid,
	type WaitReason,
	waitingInOrder,
	waitReasons,
	waitsWithRoom,
} from "./queue.ts";
import type { BuildSeen, Reading } from "./room.ts";

/** How long a shell has to say its pid before its job is given up. */
export const PID_MS = 30_000;

/** How old a lock is before it is taken as left by a session that died. */
const STALE_LOCK_MS = 10_000;

/** How often queue.json is written when nothing in it changes. */
export const HEARTBEAT_MS = 30_000;

/** How long queue.json goes unwritten before nobody keeps the queue. */
export const UNKEPT_MS = 120_000;

/**
 * The file in the queue folder listing the quests whose work goes first,
 * as quest ids, written by quest-workflow from `queue: first` in their
 * front matter.
 */
export const QUEUE_FIRST_FILE = "first.json";

/** The quests whose work goes first, as the queue folder holds them. */
function questsFirstIn(dir: string): ReadonlySet<string> {
	const ids = parsed<unknown>(join(dir, QUEUE_FIRST_FILE));
	return Array.isArray(ids)
		? new Set(ids.filter((id): id is string => typeof id === "string"))
		: NOBODY;
}

/** The machine's queue folder, in the account's runtime directory. */
export function machineQueueDir(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const runtime = env.XDG_RUNTIME_DIR;
	return runtime ? join(runtime, "jobs") : undefined;
}

/** Whether some session keeps the queue at `dir`, by queue.json's age. */
export function isKept(dir: string, now: number = Date.now()): boolean {
	try {
		return now - statSync(join(dir, "queue.json")).mtimeMs < UNKEPT_MS;
	} catch {
		return false;
	}
}

/**
 * The queue as queue.json last said it, while some session keeps it:
 * nothing once nobody has written it for {@link UNKEPT_MS}, since a
 * record nobody keeps says what ran before, not what runs now.
 */
export function readQueue(
	dir: string,
	now: number = Date.now(),
): QueueRecord | undefined {
	if (!isKept(dir, now)) return undefined;
	const record = parsed<QueueRecord>(join(dir, "queue.json"));
	return record?.v === 1 && Array.isArray(record.jobs) ? record : undefined;
}

/**
 * The whole queue, as queue.json holds it. mycelium's node reads `v`,
 * `at`, `heartbeat`, `machine` and `room` from outside the harness, so a
 * change to any of those five bumps `v`; the rest may change freely.
 */
export interface QueueRecord {
	readonly v: 1;
	readonly at: string;
	/** When it was last written, in epoch seconds. */
	readonly heartbeat: number;
	readonly machine: {
		readonly cores: number;
		readonly availableGib: number;
		readonly pressure: Reading["pressure"];
		readonly vms: number;
	};
	/** How many more VMs and builds would get their turns now. */
	readonly room: RoomLeft;
	readonly quiet: null;
	readonly jobs: readonly {
		readonly id: string;
		readonly class: Class;
		readonly kind: Job["kind"];
		readonly state: "running" | "waiting";
		readonly owner: Job["owner"];
		readonly what: string;
		readonly memoryGib: number;
		/** When it started, or began to wait. */
		readonly since: string;
		/** Its place in line, from 1, while it waits. */
		readonly place?: number;
		/** The cgroup it runs in, while it runs. */
		readonly slice?: string;
		/** Started beside a VM check, with its Nix builds capped. */
		readonly capped?: true;
		/** A build that takes seconds, with a turn of its own. */
		readonly quick?: true;
		/** The quest its session had loaded as it asked. */
		readonly quest?: string;
		/** Its quest is marked `queue: first`, so it goes ahead of bulk. */
		readonly first?: true;
		/** Waiting, and another session waits on its owner, so it goes first. */
		readonly awaited?: true;
		/**
		 * What it builds, by name, such as a check's: read from a running
		 * job's own processes, or from `what` where it is written out.
		 */
		readonly name?: string;
		/** How many seconds the same work took the last time it ran. */
		readonly lastRanS?: number;
		/** Why it waits, while it waits. */
		readonly waitingOn?: WaitReason;
	}[];
	/** Minutes some job waited today though the memory it needed was free. */
	readonly wasted: {
		readonly today: number;
		readonly day: string;
		readonly minute: string;
	};
}

/** What keeping the queue reads the processes through. */
export interface Processes {
	isRunning(pid: number): boolean;
	cgroupOf(pid: number): string | undefined;
	/**
	 * The most memory a cgroup has held, in bytes, or nothing when it
	 * can't be read. A reader that never can leaves it out.
	 */
	memoryPeakOf?(cgroup: string): number | undefined;
	/**
	 * The command line of each process in a cgroup, for naming what a job
	 * runs now. A reader that can't leaves it out, and the name then comes
	 * from what the job was asked with.
	 */
	commandsIn?(cgroup: string): readonly string[];
}

/** The machine's queue folder. */
export interface QueueFolder {
	readonly dir: string;
	/** Asks for a turn for this job. */
	ask(job: Job): void;
	/** Whether the job has its turn. */
	hasTurn(id: string): boolean;
	/** Whether any job is waiting or running. */
	hasJobs(): boolean;
	/**
	 * The kind work read as `kind` waits as, by what its last run's Nix
	 * builds ran (outcome.ts's `kindAfter`).
	 */
	kindFor(kind: Kind, what: string): Kind;
	/**
	 * Whether work of `kind` takes seconds, by its last run or what it
	 * builds (outcome.ts's `quickAfter`).
	 */
	quickFor(kind: Kind, what: string): boolean;
	/**
	 * The memory work held the last time it ran, in GiB, or nothing for
	 * work not yet seen (outcome.ts's `peakGibAfter`).
	 */
	peakFor(what: string): number | undefined;
	/** Whether queue.json is older than its heartbeat allows. */
	isDue(now: number): boolean;
	/**
	 * Gives up what has ended, starts the next job that fits, and writes
	 * queue.json when it changed or its heartbeat is due. Nothing when
	 * another session is keeping it at this moment.
	 */
	keep(
		reading: Reading,
		now: number,
		cgroupFor: (job: Job) => string | undefined,
	): void;
}

/** Every file a job has in the folder, by its ending. */
const JOB_FILES: readonly string[] = [
	"job",
	"pid",
	"turn",
	"began",
	"capped",
	"end",
];

/** How old a job's file without its .job must be to count as left over. */
const LEFTOVER_MS = 60_000;

export function queueFolder(
	dir: string,
	processes: Processes,
	rules: () => Rules = () => RULES,
	outcomes?: string,
): QueueFolder {
	const path = (id: string, ending: string) => join(dir, `${id}.${ending}`);
	const ensure = () => mkdirSync(dir, { recursive: true });

	const jobs = (): Job[] =>
		names(dir)
			.filter((name) => name.endsWith(".job"))
			.flatMap((name) => {
				const job = parsed<Job>(join(dir, name));
				return job && typeof job.id === "string" ? [job] : [];
			});

	const shellOf = (id: string): number | undefined => {
		const pid = Number(text(path(id, "pid")).trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	};

	// The queue is kept every two seconds and the file is up to 2 MiB, so
	// it is read again only once it has changed.
	let read: { readonly stamp: string; readonly outcomes: Outcome[] } = {
		stamp: "",
		outcomes: [],
	};
	const recorded = (): Outcome[] => {
		if (!outcomes) return [];
		let stamp = "";
		try {
			const { mtimeMs, size } = statSync(outcomes);
			stamp = `${mtimeMs}|${size}`;
		} catch {
			return [];
		}
		if (stamp !== read.stamp) read = { stamp, outcomes: outcomesIn(outcomes) };
		return read.outcomes;
	};

	const drop = (id: string) => {
		for (const ending of JOB_FILES) rmSync(path(id, ending), { force: true });
	};

	/**
	 * Clears what jobs left once their .job is gone. A session on older
	 * code drops a job without the files it does not know, which left a
	 * `.began` for every job it ended. A job's .job is written before its
	 * shell is handed the command, so anything else of a job without one
	 * is left over; a minute's grace covers a clock that disagrees.
	 */
	const sweep = (now: number) => {
		const all = names(dir);
		const asked = new Set(
			all
				.filter((name) => name.endsWith(".job"))
				.map((name) => name.slice(0, -4)),
		);
		for (const name of all) {
			const dot = name.lastIndexOf(".");
			const ending = name.slice(dot + 1);
			if (dot <= 0 || ending === "job" || !JOB_FILES.includes(ending)) continue;
			if (asked.has(name.slice(0, dot))) continue;
			try {
				const file = join(dir, name);
				if (now - statSync(file).mtimeMs >= LEFTOVER_MS)
					rmSync(file, { force: true });
			} catch {
				// Gone as it was looked at.
			}
		}
	};

	/** Keeps how the job ended, by its shell's word and when it said it. */
	const remember = (job: Job, now: number) => {
		if (!outcomes) return;
		const end = path(job.id, "end");
		const said = text(end).trim();
		const exit = /^\d+$/.test(said) ? Number(said) : undefined;
		let at = now;
		try {
			at = Math.min(now, statSync(end).mtimeMs);
		} catch {
			// Unsaid: it ended when it was seen to.
		}
		try {
			keepOutcome(outcomes, outcomeOf(job, at, exit));
		} catch {
			// An outcome that can't be kept never holds up the queue.
		}
	};

	const ended = (job: Job, now: number) => {
		const shell = shellOf(job.id);
		if (shell !== undefined) return !processes.isRunning(shell);
		return (
			now - Date.parse(job.since) > PID_MS ||
			!processes.isRunning(job.owner.pid)
		);
	};

	const locked = (now: number, work: () => void) => {
		const lock = join(dir, "queue.lock");
		try {
			mkdirSync(lock);
		} catch {
			let age = 0;
			try {
				age = now - statSync(lock).mtimeMs;
			} catch {
				// Gone as it was looked at: the next keep takes it.
			}
			if (age < STALE_LOCK_MS) return;
			try {
				rmdirSync(lock);
				mkdirSync(lock);
			} catch {
				return;
			}
		}
		try {
			work();
		} finally {
			rmSync(lock, { recursive: true, force: true });
		}
	};

	/**
	 * The Nix builds a running job asked for: those whose asker runs in
	 * its shell's cgroup, as the shell's own `nix` does.
	 */
	const buildsOf = (job: Job, reading: Reading): readonly BuildSeen[] => {
		const shell = shellOf(job.id);
		const own = shell !== undefined ? processes.cgroupOf(shell) : undefined;
		if (own === undefined) return [];
		return (reading.builds ?? []).filter((build) => build.asker === own);
	};

	/** The most memory a running job's own scope has held, if readable. */
	const ownPeakOf = (job: Job): number | undefined => {
		const shell = shellOf(job.id);
		const own = shell !== undefined ? processes.cgroupOf(shell) : undefined;
		return own !== undefined ? processes.memoryPeakOf?.(own) : undefined;
	};

	/**
	 * Notes in each running job the most that ran beside it, whether its
	 * builds ran a check with deadlines, and the most memory they and its
	 * own commands held, writing its file only when that grew, so a steady
	 * queue writes nothing.
	 */
	const noteBeside = (standing: Job[], reading: Reading): Job[] => {
		const running = standing.filter((job) => job.started !== undefined);
		return standing.map((job) => {
			if (job.started === undefined) return job;
			const seen = job.beside ?? NOTHING_BESIDE;
			const most = mostBeside(seen, besideNow(job, running, reading));
			const builds = buildsOf(job, reading);
			const held = builds.reduce((sum, build) => sum + build.memoryPeak, 0);
			const peak = Math.max(job.buildsPeakBytes ?? 0, held);
			const ranTimed = job.ranTimed || builds.some((build) => build.timed);
			const ownNow = ownPeakOf(job);
			const own =
				ownNow === undefined
					? job.ownPeakBytes
					: Math.max(job.ownPeakBytes ?? 0, ownNow);
			const noted: Job = {
				...job,
				beside: most,
				...(ranTimed ? { ranTimed: true } : {}),
				...(peak > 0 ? { buildsPeakBytes: peak } : {}),
				...(own !== undefined ? { ownPeakBytes: own } : {}),
			};
			if (JSON.stringify(noted) === JSON.stringify(job)) return job;
			replace(path(job.id, "job"), `${JSON.stringify(noted)}\n`);
			return noted;
		});
	};

	let written: string | undefined;

	return {
		dir,

		ask(job) {
			ensure();
			replace(path(job.id, "job"), `${JSON.stringify(job)}\n`);
		},

		hasTurn(id) {
			try {
				statSync(path(id, "turn"));
				return true;
			} catch {
				return false;
			}
		},

		hasJobs() {
			return names(dir).some((name) => name.endsWith(".job"));
		},

		kindFor(kind, what) {
			return kindAfter(kind, what, recorded());
		},

		quickFor(kind, what) {
			return quickAfter(kind, what, recorded());
		},

		peakFor(what) {
			return peakGibAfter(what, recorded());
		},

		isDue(now) {
			try {
				return now - statSync(join(dir, "queue.json")).mtimeMs >= HEARTBEAT_MS;
			} catch {
				return true;
			}
		},

		keep(reading, now, cgroupFor) {
			ensure();
			locked(now, () => {
				const standing = noteBeside(
					jobs().filter((job) => {
						if (!ended(job, now)) return true;
						remember(job, now);
						drop(job.id);
						return false;
					}),
					reading,
				);
				sweep(now);
				const awaited = standing.some((job) => job.started === undefined)
					? awaitedNow()
					: NOBODY;
				const given = rules();
				const ruled = {
					...given,
					mostVms: given.mostVms ?? vmsFor(recorded(), now),
				};
				const first = questsFirstIn(dir);
				const next = nextTurn(standing, reading, now, ruled, awaited, first);
				const queue = next
					? standing.map((job) =>
							job.id === next.id
								? { ...next, started: new Date(now).toISOString() }
								: job,
						)
					: standing;
				if (next) {
					const turn = queue.find((job) => job.id === next.id) as Job;
					replace(path(next.id, "job"), `${JSON.stringify(turn)}\n`);
					if (turn.capped) {
						const settings = ({
							maxJobs,
							cores,
						}: {
							readonly maxJobs: number;
							readonly cores: number;
						}) => `max-jobs = ${maxJobs}\ncores = ${cores}\n`;
						const cap = capFor(recorded(), now);
						replace(join(dir, "capped.conf"), settings(cap));
						replace(
							path(next.id, "capped"),
							settings(turn.quick ? QUICK_NIX : cap),
						);
					}
					replace(path(next.id, "turn"), cgroupFor(turn) ?? "");
				}
				const before = parsed<QueueRecord>(join(dir, "queue.json"));
				const record = queueRecord(
					queue,
					reading,
					now,
					before,
					processes,
					shellOf,
					ruled,
					awaited,
					first,
					recorded(),
				);
				const shape = JSON.stringify({ ...record, at: "", heartbeat: 0 });
				const due = !before || now - before.heartbeat * 1000 >= HEARTBEAT_MS;
				if (shape !== written || due) {
					replace(join(dir, "room"), roomSaid(record.room));
					replace(join(dir, "queue.json"), `${JSON.stringify(record)}\n`);
					written = shape;
				}
			});
		},
	};
}

/** The whole queue as queue.json holds it, counting a wasted minute. */
export function queueRecord(
	jobs: readonly Job[],
	reading: Reading,
	now: number,
	before: QueueRecord | undefined,
	processes: Pick<Processes, "cgroupOf" | "commandsIn">,
	shellOf: (id: string) => number | undefined = () => undefined,
	rules: Rules = RULES,
	awaited: ReadonlySet<string> = NOBODY,
	first: ReadonlySet<string> = NOBODY,
	outcomes: readonly Outcome[] = [],
): QueueRecord {
	const at = new Date(now).toISOString();
	const day = at.slice(0, 10);
	const minute = at.slice(0, 16);
	const carried =
		before?.wasted?.day === day ? before.wasted : { today: 0, day, minute: "" };
	const wasted =
		waitsWithRoom(jobs, reading) && carried.minute !== minute
			? { today: carried.today + 1, day, minute }
			: carried;
	const waiting = waitingInOrder(jobs, awaited, first);
	const reasons = waitReasons(jobs, reading, now, rules, awaited, first);
	return {
		v: 1,
		at,
		heartbeat: Math.floor(now / 1000),
		machine: {
			cores: reading.cores,
			availableGib: Math.round(reading.availableGib * 10) / 10,
			pressure: reading.pressure,
			vms: reading.vms,
		},
		room: roomLeft(jobs, reading, now, rules),
		quiet: null,
		jobs: [...jobs.filter((job) => job.started !== undefined), ...waiting].map(
			(job) => {
				const shell = shellOf(job.id);
				const slice =
					job.started !== undefined && shell !== undefined
						? processes.cgroupOf(shell)
						: undefined;
				const name =
					(slice !== undefined
						? workNameIn(processes.commandsIn?.(slice) ?? [])
						: undefined) ?? workNameIn([job.what]);
				const lastRanS = ranSAfter(job.what, outcomes);
				const waitingOn =
					job.started === undefined ? reasons.get(job.id) : undefined;
				return {
					id: job.id,
					class: CLASS_OF[job.kind],
					kind: job.kind,
					state: job.started !== undefined ? "running" : "waiting",
					owner: job.owner,
					what: job.what,
					memoryGib: needsGibOf(job),
					since: job.started ?? job.since,
					...(job.started === undefined
						? { place: waiting.indexOf(job) + 1 }
						: {}),
					...(job.started === undefined && awaited.has(job.owner.session)
						? { awaited: true as const }
						: {}),
					...(slice !== undefined ? { slice } : {}),
					...(job.capped ? { capped: true as const } : {}),
					...(job.quick ? { quick: true as const } : {}),
					...(job.quest !== undefined ? { quest: job.quest } : {}),
					...(job.quest !== undefined && first.has(job.quest)
						? { first: true as const }
						: {}),
					...(name !== undefined ? { name } : {}),
					...(lastRanS !== undefined ? { lastRanS } : {}),
					...(waitingOn !== undefined ? { waitingOn } : {}),
				};
			},
		),
		wasted,
	};
}

/** Replaces a file whole, so a reader never sees half of it. */
function replace(file: string, content: string): void {
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, content);
	renameSync(temporary, file);
}

function parsed<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function text(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function names(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
