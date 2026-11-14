/**
 * A session's jobs carried through a move to a host, or a release from
 * one back to plain pi.
 *
 * A move used to wait out every job, since a job died with the pi that
 * ran it: on 12 November a wave moved none of seven sessions, each with
 * a command of its own always running, and /host waited on the same.
 * Now a job whose work lives outside the pi says how another process
 * takes it up (`JobSpec.carry`), and only the others hold a move.
 *
 * As the moving pi ends, its move note (lib/internal/session/move.ts)
 * says where it is going, so the jobs that can be carried are let go
 * unstopped, and a `job-carried` entry in its log names each, with the
 * results it hadn't said yet. A host opens that log once the pi has
 * gone and starts the conversation as `startup`, as does a plain pi a
 * release opens on it; then each job is taken up under its own id and
 * its end said as it would have been, and a `job-carried-taken` entry
 * keeps a later start from taking them again. In a host, the note names
 * the host's own process, and the conversation's end is its own quit.
 *
 * Only bash calls are carried so far (lib/internal/shell/carried.ts). A
 * call whose shell is gone with no exit status is said as lost, with its
 * last lines; it is never dropped or run again.
 *
 * A host's own restart carries the same way: the host says it on the
 * conversation's bus before it stops it (cut-off.ts hears it), and the
 * next host resumes the conversation at `startup`. What went is said on
 * the bus too (`JOBS_CARRIED`), so the host can keep each call's shell
 * out of its unit's stop, and each job taken up is said
 * (`JOBS_TAKEN_UP`), so a lease tied to its call is taken again until it
 * ends.
 */

import {
	isMoveTarget,
	type MoveTarget,
	readMoveNote,
} from "../../lib/internal/session/move.ts";
import {
	type CarriedShell,
	isCarriedShell,
	stopCarried,
	watchCarried,
} from "../../lib/internal/shell/carried.ts";
import { removeKept } from "../../lib/internal/shell/kept.ts";
import {
	finishedSummary,
	keepInTemp,
	spoken,
} from "../../lib/jobs/hand-off.ts";
import {
	JOBS_CARRIED,
	JOBS_TAKEN_UP,
	type JobsCarried,
	type JobTakenUp,
} from "../../lib/jobs/host.ts";
import type { CarriedWork, JobOutcome } from "../../lib/jobs/index.ts";
import type { Taking } from "../../lib/jobs/take-up.ts";
import type { CarriedJob, Jobs } from "./jobs.ts";
import type { JobResult, Outbox } from "./outbox.ts";

/** The entry a moving session leaves, naming what it carried. */
export const CARRIED_ENTRY = "job-carried";

/** The entry a session that took the carried jobs up leaves. */
export const TAKEN_ENTRY = "job-carried-taken";

/** What a moving session carried, and when. */
export interface Carried {
	/** When it moved, in milliseconds since the epoch; names the move. */
	readonly at: number;
	readonly jobs: readonly CarriedJob[];
	/** Results finished and not yet said, said where it went. */
	readonly results: readonly JobResult[];
}

/**
 * Where a move carries jobs: the hosts, and plain pi, each of which opens
 * the log at `startup`.
 */
const CARRIES_TO: ReadonlySet<MoveTarget> = new Set([
	"attended",
	"background",
	"pi",
]);

/**
 * Whether this process's session `session` is ending to move on, to a
 * host or out of one, as the note its move wrote a moment before says.
 */
export function movingOn(
	session: string | undefined,
	read: (session: string) => { to: unknown; pid: number } | undefined = (one) =>
		readMoveNote(one),
	self: number = process.pid,
): boolean {
	if (session === undefined) return false;
	const note = read(session);
	return (
		note !== undefined &&
		note.pid === self &&
		isMoveTarget(note.to) &&
		CARRIES_TO.has(note.to)
	);
}

/**
 * Hand on the jobs that can be carried, writing what goes with them
 * through `append`. A record that can't be written leaves nobody to say
 * their ends, so the work is stopped instead.
 */
export function carryAway(
	jobs: Jobs,
	outbox: Pick<Outbox, "waiting">,
	append: (type: string, data: Carried) => void,
	now: number,
): Carried | undefined {
	const carried: Carried = {
		at: now,
		jobs: jobs.carryOut(),
		results: outbox.waiting(),
	};
	if (carried.jobs.length === 0 && carried.results.length === 0)
		return undefined;
	try {
		append(CARRIED_ENTRY, carried);
	} catch {
		// Nobody will be told how they end: stop them, as a quit did.
		for (const job of carried.jobs)
			if (isCarriedShell(job.work)) stopCarried(job.work);
		return undefined;
	}
	return carried;
}

/** Say on `bus` the jobs `session` carried away, once their record is written. */
export function sayCarried(
	bus: { emit(channel: string, data: unknown): void },
	session: string,
	jobs: readonly CarriedJob[],
): void {
	const said: JobsCarried = { session, jobs };
	bus.emit(JOBS_CARRIED, said);
}

/** Say on `bus` a carried job this session takes up. */
export function sayTakenUp(
	bus: { emit(channel: string, data: unknown): void },
	job: CarriedJob,
): void {
	const said: JobTakenUp = {
		jobId: job.id,
		kind: job.kind,
		label: job.label,
		...(job.toolCallId !== undefined ? { toolCallId: job.toolCallId } : {}),
	};
	bus.emit(JOBS_TAKEN_UP, said);
}

/** A field of an untyped entry. */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;
}

/** Whether an entry is the custom entry `type`. */
function isEntry(entry: unknown, type: string): boolean {
	return (
		field(entry, "type") === "custom" && field(entry, "customType") === type
	);
}

function isCarriedJob(value: unknown): value is CarriedJob {
	const work = field(value, "work");
	return (
		typeof field(value, "id") === "string" &&
		typeof field(value, "kind") === "string" &&
		typeof field(value, "label") === "string" &&
		typeof field(work, "kind") === "string"
	);
}

function isResult(value: unknown): value is JobResult {
	return (
		typeof field(value, "jobId") === "string" &&
		typeof field(value, "label") === "string" &&
		typeof field(value, "text") === "string"
	);
}

function isCarried(value: unknown): value is Carried {
	const jobs = field(value, "jobs");
	const results = field(value, "results");
	return (
		typeof field(value, "at") === "number" &&
		Array.isArray(jobs) &&
		jobs.every(isCarriedJob) &&
		Array.isArray(results) &&
		results.every(isResult)
	);
}

/** The carried jobs a session's history holds that nothing took up yet. */
export function carriedIn(branch: readonly unknown[]): Carried | undefined {
	const taken = new Set<unknown>();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (isEntry(entry, TAKEN_ENTRY))
			taken.add(field(field(entry, "data"), "at"));
		if (!isEntry(entry, CARRIED_ENTRY)) continue;
		const data = field(entry, "data");
		if (!isCarried(data) || taken.has(data.at)) return undefined;
		return data;
	}
	return undefined;
}

/** What taking the carried jobs up needs from the session taking them. */
export interface TakingUp {
	readonly jobs: Jobs;
	readonly outbox: Pick<Outbox, "post">;
	/** The conversation's key, which names a finished call's output file. */
	readonly session: string;
	readonly append: (type: string, data: { readonly at: number }) => void;
	readonly now?: () => number;
	/** Watch a carried call, for tests to stand in for. */
	readonly watch?: typeof watchCarried;
	/**
	 * Who runs carried work of another kind than the shell's: the
	 * extension that started it, asked on the bus (lib/jobs/take-up.ts).
	 */
	readonly offer?: (work: CarriedWork) => Taking | undefined;
	/** Hears each job taken up, before its work is looked at. */
	readonly taken?: (job: CarriedJob) => void;
}

/** Take up what a move carried here, under the ids it had. */
export function takeUp(carried: Carried, into: TakingUp): void {
	const now = into.now ?? Date.now;
	try {
		into.append(TAKEN_ENTRY, { at: carried.at });
	} catch {
		// A log that can't be written: taken up all the same, since a later
		// start finding them again would find their files gone.
	}
	into.jobs.reserve(carried.results.map((result) => result.jobId));
	for (const result of carried.results) into.outbox.post(result);
	for (const job of carried.jobs) {
		if (isCarriedShell(job.work)) {
			takeUpShell(job, job.work, into, now);
			continue;
		}
		const taking = into.offer?.(job.work);
		if (taking) {
			into.taken?.(job);
			const adopted = into.jobs.adopt(job.id, {
				kind: job.kind,
				label: job.label,
				...(job.toolCallId !== undefined ? { toolCallId: job.toolCallId } : {}),
				...(taking.carry ? { carry: taking.carry } : {}),
			});
			taking.start(adopted);
			continue;
		}
		// Nothing here can take this kind up: said, never dropped.
		into.jobs.adopt(job.id, job).finish({
			summary: `\`${job.label}\` was carried here by a move, but this session can't take up a ${job.kind} job, so nothing will say how it ends.`,
			failed: true,
		});
	}
}

/** Take up one carried bash call, saying its end as its own pi would have. */
function takeUpShell(
	job: CarriedJob,
	work: CarriedShell,
	into: TakingUp,
	now: () => number,
): void {
	let watching: ReturnType<typeof watchCarried> | undefined;
	let ended = false;
	const adopted = into.jobs.adopt(job.id, {
		kind: job.kind,
		label: job.label,
		...(job.toolCallId !== undefined ? { toolCallId: job.toolCallId } : {}),
		// It can move again, from what it kept, while it runs.
		carry: {
			what: () => (ended ? undefined : work),
			handed: () => watching?.handed(),
		},
	});
	// Its files go once its end is said, or once it is stopped and so said.
	adopted.onDelivered(() => removeKept(work.keep));
	// Before the first look, which may find it already ended.
	into.taken?.(job);
	watching = (into.watch ?? watchCarried)(work, adopted.signal);
	watching.ended.then((end) => {
		ended = true;
		const outcome = outcomeOf(job, work, end, into.session, now());
		if (outcome === undefined) {
			if (end.how === "stopped") removeKept(work.keep);
			return;
		}
		adopted.finish(outcome);
	});
}

/** What a carried call's end says, or nothing when it was stopped or moved on. */
function outcomeOf(
	job: CarriedJob,
	work: CarriedShell,
	end: Awaited<ReturnType<typeof watchCarried>["ended"]>,
	session: string,
	at: number,
): JobOutcome | undefined {
	const took = spoken(at - work.startedAt);
	const say = (status: string, output: string) =>
		finishedSummary(
			job.label,
			status,
			output,
			`${session}-${work.startedAt}-${job.id}`,
			keepInTemp(session, "pi-bash"),
		);
	switch (end.how) {
		case "exited":
			return {
				summary: say(`exited ${end.code} after ${took}`, end.output),
				...(end.code === 0 ? {} : { failed: true }),
			};
		case "lost":
			return {
				summary: say(
					`was lost after ${took}: its shell is gone and wrote no exit status`,
					end.output,
				),
				failed: true,
			};
		case "timed-out":
			return {
				summary: say(
					`ran out of time after ${took} and was stopped`,
					end.output,
				),
				failed: true,
			};
		default:
			return undefined;
	}
}
