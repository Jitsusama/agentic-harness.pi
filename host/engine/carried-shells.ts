/**
 * The bash calls a host's stop carries to the next host, kept alive
 * through it and watched until a conversation holds them.
 *
 * A restart used to wait on every background command, and on 13
 * November neither work host restarted for hours since each always held
 * one (QCXZEB). Now each conversation carries its calls through the
 * restart as a move does (extensions/job-workflow/moved.ts) and says on
 * its bus what went, which this hears. But a call's stub and its
 * `tee -p` are children of the host, in its unit's cgroup, and the
 * unit's stop kills that cgroup whole (KillMode=mixed): the call would
 * be said as lost. So once every conversation has parked, the host moves
 * each carried call's processes still in its own cgroup, matched by the
 * call's own mark and never by a pattern, into the cgroup `JOBS_CGROUP`
 * names, where the command they wait on already runs. That cgroup is
 * its own unit, which a host's stop never reaches, and the host's reaper
 * spares a carried call by its `.carried` mark. A moved process then
 * sits under that unit's limits, not the host's, and ends with its stop.
 *
 * A host whose pi-spawners run in scopes of their own
 * (lib/internal/shell/spawner-scope.ts) has nothing to move: its calls
 * already sit outside its unit, so it keeps them too, and since 17
 * November any stop of such a host carries them, not only its own
 * restart (host/service/serve.ts). Where there is neither a jobs cgroup
 * nor such a scope, nothing can keep them, so `keeps` is false and a
 * restart waits on them as before.
 *
 * What it kept is written down, so the next host can stop what nobody
 * holds: a call whose conversation never came back is stopped once its
 * time limit passes or a day after the restart, whichever comes first,
 * saying so in the journal. A call that ended, or that a conversation
 * this host runs has taken up, is let go. A crash or a kill -9 carries
 * nothing through here; what its conversations recorded of each call as
 * it ran (lib/internal/shell/kept-jobs.ts) spares the call from the next
 * host's reaper, and the conversation takes it up as it resumes. A
 * recorded call whose pi has gone and that no conversation here holds
 * is stopped on the same look, once its time limit or a day from its
 * start has passed.
 *
 * Every file it reads or writes, each call's `.end` and the kept list,
 * goes through fs/promises, since the host's conversations share its
 * thread. A call whose end can't be read for the moment is neither
 * stopped nor let go, and the next look asks again.
 */

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	HOST_RESTARTING_EVENT,
	isHostRestarting,
} from "../../lib/core/session/host.ts";
import { jobsProcs } from "../../lib/internal/priority/place.ts";
import {
	type CarriedShell,
	carriesMark,
	isCarriedShell,
	stopCarried,
} from "../../lib/internal/shell/carried.ts";
import {
	endRead,
	processThere,
	RECORD_SPARED_FOR_MS,
} from "../../lib/internal/shell/kept.ts";
import {
	type KeptJob,
	strayKeptJobs,
} from "../../lib/internal/shell/kept-jobs.ts";
import { CALL_VARIABLE } from "../../lib/internal/shell/reap.ts";
import { spawnersScoped } from "../../lib/internal/shell/spawner-scope.ts";
import { writeWholeOff } from "../../lib/internal/write-whole.ts";
import { isJobsCarried, JOBS_CARRIED } from "../../lib/jobs/host.ts";
import {
	linuxProcessTable,
	type ProcessTable,
	readsProcesses,
} from "./tool-children.ts";

/**
 * How long a carried call nobody took up may run on before it is
 * stopped: as long as a recorded one is spared.
 */
export const STRAY_FOR_MS = RECORD_SPARED_FOR_MS;

/** How often the host looks at what an earlier restart kept. */
export const STRAY_LOOK_MS = 10 * 60 * 1000;

const MS_PER_MINUTE = 60_000;

/** The file, in the host engine's state, that names what a restart kept. */
export const KEPT_FILE = "carried-shells.json";

/** One bash call a restart carried, as the next host reads it. */
export interface KeptCall {
	/** The conversation it was carried from. */
	readonly session: string;
	readonly job: string;
	readonly label: string;
	/** When the restart carried it, in milliseconds since the epoch. */
	readonly at: number;
	readonly work: CarriedShell;
}

/** What the engine asks of the carried calls. */
export interface CarriedShells {
	/**
	 * Whether a stop can keep a carried call alive: a jobs cgroup to move
	 * it into, or spawners in scopes of their own.
	 */
	readonly keeps: boolean;
	/**
	 * Whether a park keeps a carried call alive (parked-calls.ts). A host
	 * that runs on through the park holds the call in its own cgroup until
	 * its own stop keeps it, as `keeps` says, which it can because the
	 * park's stop tells the conversation of a restart and `heard` hears
	 * its carry (stamped with the park's time, so a call parked a day
	 * before the next host's look is stopped on it, as a parked
	 * conversation's watch wakes it after a day); a child, whose process ends
	 * once it parks (`processEnds`), keeps only what its spawners' scopes
	 * hold apart from its unit.
	 */
	keepsThroughPark(processEnds: boolean): boolean;
	/**
	 * Hear the calls a conversation's bus says it carried through a
	 * restart, once the host told it of one; a move's carry is the place
	 * it moved to's to watch. Returns a disposer.
	 */
	heard(bus: {
		on(channel: string, listener: (data: unknown) => void): () => void;
	}): () => void;
	/**
	 * Let go of the calls heard from `session`, as it is released to
	 * another holder that takes them up: this host's restart neither keeps
	 * nor, later, stops them.
	 */
	released(session: string): void;
	/**
	 * As a restart stops the host, once every conversation has parked:
	 * move each carried call out of the host's cgroup and write them down.
	 * Answers the pids it moved.
	 */
	keep(): Promise<number[]>;
	/**
	 * Look at what an earlier restart kept every `STRAY_LOOK_MS`, first
	 * once the start's resumes have had that long, stopping a call nobody
	 * holds once it is due. Answers the function that stops looking.
	 */
	watch(holds: (session: string) => boolean): () => void;
	/**
	 * Look once, as a watch does each time: stop each call nobody holds
	 * once it is due, those its jobs recorded as running among them.
	 */
	look(holds: (session: string) => boolean): Promise<void>;
}

/** What the carried calls need of the machine, for tests to stand in for. */
export interface CarriedShellsOptions {
	/** The host engine's own state folder, where `KEPT_FILE` goes. */
	readonly stateDir: string;
	/**
	 * The folder `KEPT_FILE` goes in at each use, rather than `stateDir`:
	 * a child host keeps its one conversation's own, so children on one
	 * key never write over each other's (host/service/child.ts).
	 */
	readonly keptIn?: () => string;
	/** The jobs cgroup, as `JOBS_CGROUP` names it; that setting by default, and empty for none. */
	readonly jobs?: string | undefined;
	/** This process's /proc/self/cgroup; read from /proc by default. */
	readonly ownCgroup?: () => string;
	/**
	 * Whether the host's spawners run in scopes of their own; asked of the
	 * machine each time by default, since a scope can fail to start.
	 */
	readonly scoped?: boolean;
	/**
	 * The recorded calls whose pi has gone; read from the kept folder,
	 * off the thread, by default.
	 */
	readonly recorded?: () => readonly KeptJob[] | Promise<readonly KeptJob[]>;
	readonly table?: ProcessTable;
	/** Writes a pid into a cgroup.procs file. */
	readonly move?: (procs: string, pid: number) => Promise<void>;
	/**
	 * Whether a call's shell is there, as the call it was; rejecting when
	 * that can't be read for the moment, which leaves the call as it is.
	 */
	readonly running?: (work: CarriedShell) => boolean | Promise<boolean>;
	readonly stop?: (work: CarriedShell) => void;
	readonly say: (line: string) => void;
	readonly report: (error: unknown) => void;
	readonly now?: () => number;
	/** Starts a repeating timer; setInterval, unref'd, by default. */
	readonly every?: (ms: number, run: () => void | Promise<void>) => () => void;
}

/**
 * Whether the shell of a carried call is still there, as itself. Its
 * end is read off the thread: a host looks on the loop its
 * conversations share, once for each call recorded, and on 23 November
 * the same read of `.end` in the parked calls' watch held that loop 5 s
 * at a time (parked-calls.ts).
 */
async function running(work: CarriedShell): Promise<boolean> {
	if ((await endRead(work.keep)) !== undefined) return false;
	if (!processThere(work.pid)) return false;
	return carriesMark(work.pid, work.mark);
}

function isKeptCall(value: unknown): value is KeptCall {
	if (typeof value !== "object" || value === null) return false;
	const { session, job, label, at, work } = value as Record<string, unknown>;
	return (
		typeof session === "string" &&
		typeof job === "string" &&
		typeof label === "string" &&
		typeof at === "number" &&
		isCarriedShell(work)
	);
}

/** What an earlier restart wrote down, or none when it wrote nothing readable. */
async function readKept(file: string): Promise<KeptCall[]> {
	try {
		const read: unknown = JSON.parse(await readFile(file, "utf8"));
		return Array.isArray(read) ? read.filter(isKeptCall) : [];
	} catch {
		// No file: no restart kept anything, or the last look let it all go.
		return [];
	}
}

/** Keep a host's carried calls through its restart, and watch an earlier one's. */
export function carriedShells(options: CarriedShellsOptions): CarriedShells {
	const now = options.now ?? Date.now;
	const table = options.table ?? linuxProcessTable();
	const keptIn = options.keptIn ?? (() => options.stateDir);
	const keptFile = () => join(keptIn(), KEPT_FILE);
	const ownCgroup =
		options.ownCgroup ?? (() => readFileSync("/proc/self/cgroup", "utf8"));
	let procs: string | undefined;
	try {
		procs = jobsProcs(ownCgroup(), options.jobs ?? process.env.JOBS_CGROUP);
	} catch {
		// No cgroups to read, as off Linux: nowhere to keep anything.
		procs = undefined;
	}
	const move =
		options.move ??
		((path: string, pid: number) => writeFile(path, `${pid}\n`));
	// Where no process table can say a pid is still the call it was, as on
	// a Mac, a reused pid could lead anyone's group, so none is judged
	// running and none is ever killed: each record is let go unread.
	const judge =
		options.running ?? (readsProcesses(table) ? running : () => false);
	// Whether a call runs, or nothing while that can't be read: such a
	// call is neither stopped nor let go, and the next look asks again.
	const runs = async (work: CarriedShell): Promise<boolean | undefined> => {
		try {
			return await judge(work);
		} catch {
			// Its end failed to read for the moment: not known either way.
			return undefined;
		}
	};
	// Each look and keep reads the kept file and writes it back off the
	// thread, so one waits for the last to land, or a look's older list
	// would write over what a restart's keep just added.
	let keptFileTurn: Promise<unknown> = Promise.resolve();
	const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
		const turn = keptFileTurn.then(work, work);
		keptFileTurn = turn.catch(() => {
			// The turn's own caller hears its error; the next turn still runs.
		});
		return turn;
	};
	const stop = options.stop ?? stopCarried;
	const recorded = options.recorded ?? (() => strayKeptJobs());
	const carried: KeptCall[] = [];

	/**
	 * Drop from `carried` each call of `calls` that ended, keeping one not
	 * known either way, as a restart keeps whatever may still run.
	 */
	async function forgetEnded(calls: readonly KeptCall[]): Promise<void> {
		for (const call of calls) {
			if ((await runs(call.work)) !== false) continue;
			const at = carried.indexOf(call);
			if (at >= 0) carried.splice(at, 1);
		}
	}

	// One look over the table for every call, since the stop it runs in
	// has a minute and a call each would read every pid's cgroup again.
	async function moveOut(
		calls: readonly KeptCall[],
		into: string,
	): Promise<number[]> {
		const own = table.cgroup(table.self);
		const marks = new Set(calls.map((call) => call.work.mark));
		const moved: number[] = [];
		for (const pid of table.pids()) {
			if (pid === table.self || table.cgroup(pid) !== own) continue;
			const mark = (await table.environ(pid, `${CALL_VARIABLE}=`))?.[
				CALL_VARIABLE
			];
			if (mark === undefined || !marks.has(mark)) continue;
			try {
				await move(into, pid);
				moved.push(pid);
			} catch (error) {
				// Gone as it was moved is what it ending meant; anything else is said.
				const code = (error as NodeJS.ErrnoException | undefined)?.code;
				if (code !== "ESRCH") options.report(error);
			}
		}
		return moved;
	}

	async function write(calls: readonly KeptCall[]): Promise<void> {
		try {
			await writeWholeOff(keptFile(), `${JSON.stringify(calls)}\n`);
		} catch (error) {
			options.report(error);
		}
	}

	/** Stop each recorded call due, whose pi has gone and nobody holds. */
	async function lookRecorded(
		holds: (session: string) => boolean,
	): Promise<void> {
		for (const job of await recorded()) {
			if ((await runs(job.work)) !== true || holds(job.session)) continue;
			const due = Math.min(
				job.work.deadline ?? Number.POSITIVE_INFINITY,
				job.work.startedAt + RECORD_SPARED_FOR_MS,
			);
			if (now() < due) continue;
			stop(job.work);
			const why =
				job.work.deadline !== undefined && job.work.deadline <= due
					? "its time limit passed"
					: "a day passed";
			options.say(
				`Stopped \`${job.label}\` (${job.id} of ${job.session}), recorded as it ran: its conversation never took it up and ${why}`,
			);
		}
	}

	async function look(holds: (session: string) => boolean): Promise<void> {
		await lookRecorded(holds);
		await inTurn(() => lookKept(holds));
	}

	/** Stop each call an earlier restart kept that is due and nobody holds. */
	async function lookKept(holds: (session: string) => boolean): Promise<void> {
		const kept = await readKept(keptFile());
		if (kept.length === 0) return;
		const left: KeptCall[] = [];
		for (const call of kept) {
			const out = await runs(call.work);
			// Not known yet: kept for the next look, never stopped unread.
			if (out === undefined) {
				left.push(call);
				continue;
			}
			if (!out || holds(call.session)) continue;
			const due = Math.min(
				call.work.deadline ?? Number.POSITIVE_INFINITY,
				call.at + STRAY_FOR_MS,
			);
			if (now() < due) {
				left.push(call);
				continue;
			}
			stop(call.work);
			const why =
				call.work.deadline !== undefined && call.work.deadline <= due
					? "its time limit passed"
					: "a day passed";
			options.say(
				`Stopped \`${call.label}\` (${call.job} of ${call.session}), carried through a restart: its conversation never came back and ${why}`,
			);
		}
		if (left.length !== kept.length) await write(left);
	}

	const scoped = () => options.scoped ?? spawnersScoped();
	return {
		get keeps() {
			return procs !== undefined || scoped();
		},
		keepsThroughPark(processEnds) {
			return processEnds ? scoped() : procs !== undefined || scoped();
		},
		heard(bus) {
			let restarting = false;
			const told = bus.on(HOST_RESTARTING_EVENT, (data) => {
				if (isHostRestarting(data)) restarting = true;
			});
			// A park's stop tells its conversation of a restart too, so a shared
			// host hears every carrying park here: those that ended since go,
			// so the list holds no more than the calls still out.
			const carrying = bus.on(JOBS_CARRIED, (data) => {
				if (!restarting || !isJobsCarried(data)) return;
				// Looked at off the thread, as the bus can't wait: a call that
				// ended meanwhile is dropped by the keep's own look besides.
				void forgetEnded([...carried]).catch(options.report);
				for (const job of data.jobs)
					if (isCarriedShell(job.work))
						carried.push({
							session: data.session,
							job: job.id,
							label: job.label,
							at: now(),
							work: job.work,
						});
			});
			return () => {
				told();
				carrying();
			};
		},
		released(session) {
			const kept = carried.filter((call) => call.session !== session);
			carried.splice(0, carried.length, ...kept);
		},
		async keep() {
			await forgetEnded([...carried]);
			if (carried.length === 0) return [];
			const moved: number[] = [];
			if (procs !== undefined) moved.push(...(await moveOut(carried, procs)));
			// What an earlier restart kept and nobody took up yet goes on too.
			await inTurn(async () =>
				write([...(await readKept(keptFile())), ...carried]),
			);
			return moved;
		},
		watch(holds) {
			const every =
				options.every ??
				((ms: number, run: () => void) => {
					const timer = setInterval(run, ms);
					timer.unref();
					return () => clearInterval(timer);
				});
			// A tick while a slow disk still holds the last look waits for
			// the next, so no call is stopped, or said stopped, twice. A look
			// still out a whole tick later is said once, since until it
			// comes back nothing kept is looked at.
			let under: Promise<void> | undefined;
			let saidStuck = false;
			const looking = () => {
				if (under !== undefined) {
					if (!saidStuck) {
						saidStuck = true;
						options.report(
							new Error(
								`the last look at what earlier restarts kept has not come back in ${STRAY_LOOK_MS / MS_PER_MINUTE} minutes, so none is looked at until it does`,
							),
						);
					}
					return under;
				}
				saidStuck = false;
				under = look(holds)
					.catch(options.report)
					.finally(() => {
						under = undefined;
					});
				return under;
			};
			return every(STRAY_LOOK_MS, looking);
		},
		look,
	};
}
