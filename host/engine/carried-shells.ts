/**
 * The bash calls a host's own restart carries to the next host, kept
 * alive through the stop and watched until a conversation holds them.
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
 * Where there is no jobs cgroup, nothing can keep them, so `keeps` is
 * false and a restart waits on them as before.
 *
 * What it kept is written down, so the next host can stop what nobody
 * holds: a call whose conversation never came back is stopped once its
 * time limit passes or a day after the restart, whichever comes first,
 * saying so in the journal. A call that ended, or that a conversation
 * this host runs has taken up, is let go. A crash or a kill -9 carries
 * nothing: the next host's reaper ends what it left, as before.
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
import { endOf } from "../../lib/internal/shell/kept.ts";
import { CALL_VARIABLE } from "../../lib/internal/shell/reap.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";
import { isJobsCarried, JOBS_CARRIED } from "../../lib/jobs/host.ts";
import { linuxProcessTable, type ProcessTable } from "./tool-children.ts";

/** How long a carried call nobody took up may run on before it is stopped. */
export const STRAY_FOR_MS = 24 * 60 * 60 * 1000;

/** How often the host looks at what an earlier restart kept. */
export const STRAY_LOOK_MS = 10 * 60 * 1000;

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
	/** Whether a restart can keep a carried call alive through the stop. */
	readonly keeps: boolean;
	/**
	 * Hear the calls a conversation's bus says it carried through a
	 * restart, once the host told it of one; a move's carry is the place
	 * it moved to's to watch. Returns a disposer.
	 */
	heard(bus: {
		on(channel: string, listener: (data: unknown) => void): () => void;
	}): () => void;
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
}

/** What the carried calls need of the machine, for tests to stand in for. */
export interface CarriedShellsOptions {
	/** The host engine's own state folder, where `KEPT_FILE` goes. */
	readonly stateDir: string;
	/** The jobs cgroup, as `JOBS_CGROUP` names it; that setting by default, and empty for none. */
	readonly jobs?: string | undefined;
	/** This process's /proc/self/cgroup; read from /proc by default. */
	readonly ownCgroup?: () => string;
	readonly table?: ProcessTable;
	/** Writes a pid into a cgroup.procs file. */
	readonly move?: (procs: string, pid: number) => Promise<void>;
	/** Whether a call's shell is there, as the call it was. */
	readonly running?: (work: CarriedShell) => boolean;
	readonly stop?: (work: CarriedShell) => void;
	readonly say: (line: string) => void;
	readonly report: (error: unknown) => void;
	readonly now?: () => number;
	/** Starts a repeating timer; setInterval, unref'd, by default. */
	readonly every?: (ms: number, run: () => void) => () => void;
}

/** Whether the shell of a carried call is still there, as itself. */
function running(work: CarriedShell): boolean {
	if (endOf(work.keep) !== undefined) return false;
	try {
		process.kill(work.pid, 0);
	} catch (error) {
		// EPERM: there, and somebody else's, which a carried shell never is.
		if (!(error instanceof Error && "code" in error && error.code === "EPERM"))
			return false;
	}
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
function readKept(file: string): KeptCall[] {
	try {
		const read: unknown = JSON.parse(readFileSync(file, "utf8"));
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
	const file = join(options.stateDir, KEPT_FILE);
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
	const isRunning = options.running ?? running;
	const stop = options.stop ?? stopCarried;
	const carried: KeptCall[] = [];

	async function moveOut(call: KeptCall, into: string): Promise<number[]> {
		const own = table.cgroup(table.self);
		const moved: number[] = [];
		const sought = `${CALL_VARIABLE}=${call.work.mark}`;
		for (const pid of table.pids()) {
			if (pid === table.self || table.cgroup(pid) !== own) continue;
			const environ = await table.environ(pid, sought);
			if (environ?.[CALL_VARIABLE] !== call.work.mark) continue;
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

	function write(calls: readonly KeptCall[]): void {
		try {
			writeWhole(file, `${JSON.stringify(calls)}\n`);
		} catch (error) {
			options.report(error);
		}
	}

	function look(holds: (session: string) => boolean): void {
		const kept = readKept(file);
		if (kept.length === 0) return;
		const left = kept.filter((call) => {
			if (!isRunning(call.work) || holds(call.session)) return false;
			const due = Math.min(
				call.work.deadline ?? Number.POSITIVE_INFINITY,
				call.at + STRAY_FOR_MS,
			);
			if (now() < due) return true;
			stop(call.work);
			const why =
				call.work.deadline !== undefined && call.work.deadline <= due
					? "its time limit passed"
					: "a day passed";
			options.say(
				`Stopped \`${call.label}\` (${call.job} of ${call.session}), carried through a restart: its conversation never came back and ${why}`,
			);
			return false;
		});
		if (left.length !== kept.length) write(left);
	}

	return {
		keeps: procs !== undefined,
		heard(bus) {
			let restarting = false;
			const told = bus.on(HOST_RESTARTING_EVENT, (data) => {
				if (isHostRestarting(data)) restarting = true;
			});
			const carrying = bus.on(JOBS_CARRIED, (data) => {
				if (!restarting || !isJobsCarried(data)) return;
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
		async keep() {
			if (carried.length === 0) return [];
			const moved: number[] = [];
			if (procs !== undefined)
				for (const call of carried) moved.push(...(await moveOut(call, procs)));
			// What an earlier restart kept and nobody took up yet goes on too.
			write([...readKept(file), ...carried]);
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
			const looking = () => {
				try {
					look(holds);
				} catch (error) {
					options.report(error);
				}
			};
			return every(STRAY_LOOK_MS, looking);
		},
	};
}
