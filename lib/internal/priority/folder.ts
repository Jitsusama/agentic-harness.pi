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
 *   with `capped.conf`, the Nix settings {@link CAPPED_NIX} holds,
 *   first in `NIX_USER_CONF_FILES`.
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
import {
	besideNow,
	capFor,
	keepOutcome,
	mostBeside,
	NOTHING_BESIDE,
	outcomeOf,
	outcomesIn,
} from "./outcome.ts";
import {
	CLASS_OF,
	type Class,
	type Job,
	NEEDS_GIB,
	nextTurn,
	type RoomLeft,
	RULES,
	type Rules,
	roomLeft,
	roomSaid,
	waitingInOrder,
	waitsWithRoom,
} from "./queue.ts";
import type { Reading } from "./room.ts";

/** How long a shell has to say its pid before its job is given up. */
export const PID_MS = 30_000;

/** How old a lock is before it is taken as left by a session that died. */
const STALE_LOCK_MS = 10_000;

/** How often queue.json is written when nothing in it changes. */
export const HEARTBEAT_MS = 30_000;

/** How long queue.json goes unwritten before nobody keeps the queue. */
export const UNKEPT_MS = 120_000;

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

/** The whole queue, as queue.json holds it. */
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

	const drop = (id: string) => {
		for (const ending of ["job", "pid", "turn", "capped", "end"]) {
			rmSync(path(id, ending), { force: true });
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
	 * Notes in each running job the most that ran beside it, writing its
	 * file only when that grew, so a steady queue writes nothing.
	 */
	const noteBeside = (standing: Job[], reading: Reading): Job[] => {
		const running = standing.filter((job) => job.started !== undefined);
		return standing.map((job) => {
			if (job.started === undefined) return job;
			const seen = job.beside ?? NOTHING_BESIDE;
			const most = mostBeside(seen, besideNow(job, running, reading));
			if (JSON.stringify(most) === JSON.stringify(job.beside)) return job;
			const noted = { ...job, beside: most };
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
				const next = nextTurn(standing, reading, now, rules());
				const queue = next
					? standing.map((job) =>
							job.id === next.id
								? { ...next, started: new Date(now).toISOString() }
								: job,
						)
					: standing;
				if (next) {
					const given = queue.find((job) => job.id === next.id) as Job;
					replace(path(next.id, "job"), `${JSON.stringify(given)}\n`);
					if (given.capped) {
						const cap = capFor(outcomes ? outcomesIn(outcomes) : [], now);
						replace(
							join(dir, "capped.conf"),
							`max-jobs = ${cap.maxJobs}\ncores = ${cap.cores}\n`,
						);
						replace(path(next.id, "capped"), "");
					}
					replace(path(next.id, "turn"), cgroupFor(given) ?? "");
				}
				const before = parsed<QueueRecord>(join(dir, "queue.json"));
				const record = queueRecord(
					queue,
					reading,
					now,
					before,
					processes,
					shellOf,
					rules(),
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
	processes: Pick<Processes, "cgroupOf">,
	shellOf: (id: string) => number | undefined = () => undefined,
	rules: Rules = RULES,
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
	const waiting = waitingInOrder(jobs);
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
				return {
					id: job.id,
					class: CLASS_OF[job.kind],
					kind: job.kind,
					state: job.started !== undefined ? "running" : "waiting",
					owner: job.owner,
					what: job.what,
					memoryGib: NEEDS_GIB[job.kind],
					since: job.started ?? job.since,
					...(job.started === undefined
						? { place: waiting.indexOf(job) + 1 }
						: {}),
					...(slice !== undefined ? { slice } : {}),
					...(job.capped ? { capped: true as const } : {}),
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
