/**
 * A session the machine ended mid-work, given a turn when it returns.
 *
 * pi resumes nothing on its own: a session restored after a reboot sits
 * at its prompt, though its last run was cut off or a job it waited on
 * died with it. On 24 October a reboot left three sessions so, two
 * mid-run and one waiting on a fleet, until another session asked them
 * to carry on.
 *
 * A signal (SIGTERM or SIGHUP: a reboot, a logout, a closed terminal)
 * is what tells the machine ending a session from the person ending
 * it. pi emits `session_shutdown` before it aborts the run, so a run
 * still under way then was cut off; a run the person stopped with
 * Escape has settled long before. When a signal ends the session with
 * a run or a job under way, an entry records it, and the restored
 * session is told where it stopped until a prompt takes it up. An
 * uncaught error ends pi with no signal, so the same entry is left as
 * it dies (`lib/internal/session/crash-record.ts`); on 11 November five
 * lanes waiting on jobs died so and came back idle for two hours. A
 * session killed outright writes nothing, so a log that stops mid-run,
 * on a tool call or its result, is read the same way.
 *
 * A host carries a run on itself: it parks the run as it stops the
 * conversation and the next start takes it up. So a record a host
 * leaves says its run is carried, and the session is told only of the
 * jobs that died. On 14 November the 08:37 restart carried one run to
 * its end, then told it nothing had resumed it and to rerun what
 * mattered. Both must hold: the record says so, since a session plain
 * pi left cut off has no run for a host to carry, and the session
 * returns in a host, since plain pi carries nothing. A host's
 * conversations reopened in plain pi, as a rollback does, are told
 * their run died.
 *
 * A carried run can still be lost: at the 22:22 reboot on 14 November
 * the next host failed a run it had cut mid-answer, and the session,
 * told nothing, sat until a mesh message came. So a hosted session
 * whose record says carried waits for the run to show an answer that
 * isn't an error, and is told it was cut off if, with nothing typed,
 * a run settles with none, or none has started within
 * `CARRIED_RUN_WAIT_MS`. A carried run waits its turn behind
 * every other the restart carries, so how long it takes to start says
 * nothing of whether it was carried; only how it ends does.
 *
 * A host's run is carried from its own record, whatever ended the last
 * host, so a hosted log that stops mid-run waits the same way. On 20
 * November the 04:35 restart killed runs wedged since 03:03 and 04:11,
 * leaving no record. The next host carried each on at once, yet each
 * was queued "nothing has resumed it since", and was told so up to two
 * hours later, at its first idle moment. A log plain pi left so, opened
 * in a host that has no run to carry, is told once the wait is up. Its
 * host's own result for the tool call the kill cut is no answer: the
 * run it carries may still fail after it.
 *
 * A move back to plain pi that waited too long on a run ends it at its
 * turn's end and leaves the same record, naming itself as what ended it
 * (mesh-workflow moving.ts), so plain pi is told the move stopped it,
 * not the machine.
 */

import {
	HOST_RESTARTING_EVENT,
	isHostRestarting,
} from "../../lib/core/session/host.ts";
import {
	isSessionStamp,
	SESSION_STAMP_EVENT,
} from "../../lib/core/session/index.ts";
import {
	CUT_OFF_ENTRY,
	type CutJob,
	type CutOff,
	isRefusedRun,
} from "../../lib/internal/session/cut-off-record.ts";

// The record's shape is shared with a move that ends a run, which reads
// no sibling extension (lib/internal/session/cut-off-record.ts).
export { CUT_OFF_ENTRY };

/**
 * How long a returning hosted session waits for the run its host carried
 * to start, before it is told the run was cut off: the next host takes
 * runs up a few at a time, and on 20 November its 107 resumes took
 * 805 s, so a run's turn can come many minutes after its return. It is
 * no bound: a bigger restart's last turns can come later still, and are
 * told they were cut off, and their run's own answer follows.
 */
export const CARRIED_RUN_WAIT_MS = 30 * 60_000;

/**
 * How soon a wait whose time is up looks again while the session is busy
 * or a run is under way: the session is told only once it rests, and a
 * run that answers decides as it settles.
 */
export const CARRIED_RUN_RECHECK_MS = 60_000;

/** The record to leave at a signalled end; none when nothing was under way. */
export function endedRecord(
	running: boolean,
	jobs: readonly CutJob[],
	now: number,
	runCarried = false,
): CutOff | undefined {
	if (!running && jobs.length === 0) return undefined;
	if (running && runCarried)
		return { at: now, running, runCarried, jobs: [...jobs] };
	return { at: now, running, jobs: [...jobs] };
}

/** A field of an untyped entry. */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function isCutOff(value: unknown): value is CutOff {
	const jobs = field(value, "jobs");
	const runCarried = field(value, "runCarried");
	const by = field(value, "by");
	return (
		typeof field(value, "at") === "number" &&
		typeof field(value, "running") === "boolean" &&
		(runCarried === undefined || typeof runCarried === "boolean") &&
		(by === undefined || typeof by === "string") &&
		Array.isArray(jobs) &&
		jobs.every(
			(job) =>
				typeof field(job, "id") === "string" &&
				typeof field(job, "label") === "string",
		)
	);
}

/** The role of a message entry, or nothing for any other entry. */
function roleOf(entry: unknown): string | undefined {
	if (field(entry, "type") !== "message") return undefined;
	const role = field(field(entry, "message"), "role");
	return typeof role === "string" ? role : undefined;
}

/**
 * Whether a session's history says it was cut off and nothing has
 * taken it up since: what was under way, or nothing. Returning in a
 * host, a run its host carries on has been taken up, so only a job dead
 * with it counts, and a log that stops mid-run is a run the host
 * carries on; elsewhere nothing carries it.
 */
export function cutOffIn(
	branch: readonly unknown[],
	returnsInHost = false,
): CutOff | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		// A prompt since the record took it up; a later kill is read below.
		if (roleOf(entry) === "user") break;
		if (
			field(entry, "type") === "custom" &&
			field(entry, "customType") === CUT_OFF_ENTRY
		) {
			const data = field(entry, "data");
			if (!isCutOff(data)) return undefined;
			if (!data.runCarried) return data;
			if (!returnsInHost)
				return { at: data.at, running: data.running, jobs: data.jobs };
			return data.jobs.length === 0 ? undefined : data;
		}
	}
	return returnsInHost ? undefined : killedIn(branch);
}

/**
 * What a cut-off left dead once the session took some of its jobs up
 * again, as a call recorded beside its kept files is (recorded.ts):
 * nothing, when no run was cut and every job lives on, or a run its
 * host carries on was the only other loss.
 */
export function leftDead(
	cut: CutOff | undefined,
	held: ReadonlySet<string>,
): CutOff | undefined {
	if (cut === undefined) return undefined;
	const jobs = cut.jobs.filter((job) => !held.has(job.id));
	if (jobs.length === cut.jobs.length) return cut;
	if (jobs.length === 0 && (!cut.running || cut.runCarried)) return undefined;
	return { ...cut, jobs };
}

/**
 * The run a host carries on with no job dead with it, and nothing typed
 * since, from its record or from a log that stops mid-run: told nothing
 * on the return, since the next host takes the run up, but owed a
 * notice if that run never shows.
 */
export function carriedRunIn(branch: readonly unknown[]): CutOff | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		// A prompt since the record took it up; a later kill is read below.
		if (roleOf(entry) === "user") break;
		if (
			field(entry, "type") === "custom" &&
			field(entry, "customType") === CUT_OFF_ENTRY
		) {
			const data = field(entry, "data");
			return isCutOff(data) && data.runCarried && data.jobs.length === 0
				? data
				: undefined;
		}
	}
	return killedIn(branch);
}

/**
 * How the run a host carried on went since `since`, the branch's length
 * as the session returned, read from its newest answer: `answered` when
 * that is neither an error nor a tool call, `failed` when it is one of
 * those, and `unseen` when no answer came at all. A failed answer is no
 * run, nor is one that stopped on a tool call it never saw through: on
 * 14 November a reboot's next host failed a carried run it had cut
 * mid-answer. Nor is a tool's result, which a host gives the call a
 * kill cut before the run it carries answers, or fails; nor the error a
 * host answers a run it never admitted, as one asked while it carries
 * another on, which says nothing of how that one went. The host marks
 * those (cut-off-record.ts).
 */
export function carriedRunWent(
	branch: readonly unknown[],
	since: number,
): "answered" | "failed" | "unseen" {
	for (let i = branch.length - 1; i >= since; i--) {
		const entry = branch[i];
		if (roleOf(entry) !== "assistant") continue;
		const message = field(entry, "message");
		const stopped = field(message, "stopReason");
		if (isRefusedRun(message)) continue;
		if (stopped === "error" && refusedAsBusy(field(message, "errorMessage")))
			continue;
		return stopped === "error" || stopped === "toolUse" ? "failed" : "answered";
	}
	return "unseen";
}

/**
 * Whether `error` is durable's refusal of a run while its conversation
 * was busy (its `ConversationBusy`, "Conversation ID is busy"), which a
 * host ends that run with as an error answer of its own. Only for logs a
 * host wrote before it marked those answers; a marked one is known by
 * its mark, whatever durable's words.
 */
function refusedAsBusy(error: unknown): boolean {
	return typeof error === "string" && /^Conversation \S+ is busy$/.test(error);
}

/** A log that stops on a tool call or its result: a session killed mid-run. */
function killedIn(branch: readonly unknown[]): CutOff | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		const role = roleOf(entry);
		if (role === undefined) continue;
		const stopped = field(field(entry, "message"), "stopReason");
		if (
			role !== "toolResult" &&
			!(role === "assistant" && stopped === "toolUse")
		)
			return undefined;
		const at = Date.parse(String(field(entry, "timestamp")));
		return { at: Number.isNaN(at) ? 0 : at, running: true, jobs: [] };
	}
	return undefined;
}

/** What the restored session is told, its time said by `time`. */
export function resumeText(cut: CutOff, time: (at: number) => string): string {
	const when = endedWhen(cut, time);
	const what = cut.runCarried
		? `${when}. Its host carried on the run it had under way, but nothing has taken up its background work.`
		: cut.running
			? `${when}, mid-run, and nothing has resumed it since.`
			: `${when}, while it waited on background work, and nothing has resumed it since.`;
	return `${what}${diedWith(cut)}${CARRY_ON}`;
}

/**
 * What a session is told when the run its host carried on ended in an
 * error, its time said by `time`: the run was resumed, and failed.
 */
export function carriedRunFailedText(
	cut: CutOff,
	time: (at: number) => string,
): string {
	const what = `${endedWhen(cut, time)}, mid-run. Its host carried the run on, and it ended in an error.`;
	return `${what}${diedWith(cut)}${CARRY_ON}`;
}

/** How a session's end is said, its time said by `time`. */
function endedWhen(cut: CutOff, time: (at: number) => string): string {
	return `This session ended at ${time(cut.at)}, when ${cut.by ?? "the machine"} stopped it rather than the person`;
}

/** What a session is told to do on its return. */
const CARRY_ON =
	" Read where your log stops and carry on from there, rerunning what still matters; a mesh hold still standing comes first. If an orchestrator gave you this work, tell it once, by mesh, that you came back and what you carry on with.";

/** The jobs that died with a session, said for its return, or nothing. */
function diedWith(cut: CutOff): string {
	return cut.jobs.length > 0
		? ` These jobs died with it and will never report: ${cut.jobs
				.map((job) => `${job.id} (${job.label})`)
				.join(
					", ",
				)}. Anything they started outside this machine, such as cloud VMs, may still be running.`
		: "";
}

/** Where signals are heard: the process, or a stand-in under test. */
export interface SignalSource {
	on(signal: string, listener: () => void): unknown;
	off(signal: string, listener: () => void): unknown;
}

/** The signals that end a session the person did not end. */
const ENDING = ["SIGTERM", "SIGHUP"] as const;

/** Whether a session's end was the machine's, heard until stopped. */
export interface EndWatch {
	signalled(): boolean;
	/**
	 * Whether the end is its host's own restart, which resumes it in the
	 * next host, so what can outlive the stop is carried there. Only a
	 * host says so; a signal to plain pi never does.
	 */
	restarting?(): boolean;
	stop(): void;
}

/** Hear whether a signal ends this session, until stopped. */
export function watchSignals(source: SignalSource): EndWatch {
	let heard = false;
	const listener = () => {
		heard = true;
	};
	for (const signal of ENDING) source.on(signal, listener);
	return {
		signalled: () => heard,
		stop: () => {
			for (const signal of ENDING) source.off(signal, listener);
		},
	};
}

/** Where a host's stamps are heard: the conversation's own bus. */
export interface StampSource {
	on(channel: string, listener: (data: unknown) => void): () => void;
}

/**
 * Hear whether the host stopped this conversation, until stopped. In a
 * host a signal reaches the process, so every conversation it runs, and
 * the host says which ended how: it stamps each conversation it stops
 * `signalled` on that conversation's bus before its shutdown runs, and
 * one the person closed `closed`. A reload stamps nothing.
 */
export function watchStamps(bus: StampSource, session: string): EndWatch {
	let heard = false;
	let restart = false;
	const offStamps = bus.on(SESSION_STAMP_EVENT, (data) => {
		if (isSessionStamp(data) && data.session === session)
			heard = data.how === "signalled";
	});
	// Said just before the stamp, by a host stopping to restart itself.
	const offRestart = bus.on(HOST_RESTARTING_EVENT, (data) => {
		if (isHostRestarting(data) && data.session === session) restart = true;
	});
	return {
		signalled: () => heard,
		restarting: () => heard && restart,
		stop: () => {
			offStamps();
			offRestart();
		},
	};
}
