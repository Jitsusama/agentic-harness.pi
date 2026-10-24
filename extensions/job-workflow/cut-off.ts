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
 * session is told where it stopped until a prompt takes it up. A
 * session killed outright writes nothing, so a log that stops mid-run,
 * on a tool call or its result, is read the same way.
 */

/** The entry a session's signalled end leaves when work was under way. */
export const CUT_OFF_ENTRY = "job-session-cut-off";

/** A job as the record names it. */
export interface CutJob {
	readonly id: string;
	readonly label: string;
}

/** What was under way when a session was cut off, and when. */
export interface CutOff {
	/** When it ended, in milliseconds since the epoch. */
	readonly at: number;
	/** Whether a run was under way. */
	readonly running: boolean;
	/** The jobs still running, which died with it. */
	readonly jobs: readonly CutJob[];
}

/** The record to leave at a signalled end; none when nothing was under way. */
export function endedRecord(
	running: boolean,
	jobs: readonly CutJob[],
	now: number,
): CutOff | undefined {
	if (!running && jobs.length === 0) return undefined;
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
	return (
		typeof field(value, "at") === "number" &&
		typeof field(value, "running") === "boolean" &&
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
 * taken it up since: what was under way, or nothing.
 */
export function cutOffIn(branch: readonly unknown[]): CutOff | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		// A prompt since the record took it up; a later kill is read below.
		if (roleOf(entry) === "user") break;
		if (
			field(entry, "type") === "custom" &&
			field(entry, "customType") === CUT_OFF_ENTRY
		) {
			const data = field(entry, "data");
			return isCutOff(data) ? data : undefined;
		}
	}
	return killedIn(branch);
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
	const when = `This session ended at ${time(cut.at)}, when the machine stopped it rather than the person`;
	const what = cut.running
		? `${when}, mid-run, and nothing has resumed it since.`
		: `${when}, while it waited on background work, and nothing has resumed it since.`;
	const died =
		cut.jobs.length > 0
			? ` These jobs died with it and will never report: ${cut.jobs
					.map((job) => `${job.id} (${job.label})`)
					.join(
						", ",
					)}. Anything they started outside this machine, such as cloud VMs, may still be running.`
			: "";
	return `${what}${died} Read where your log stops and carry on from there, rerunning what still matters; a mesh hold still standing comes first.`;
}

/** Where signals are heard: the process, or a stand-in under test. */
export interface SignalSource {
	on(signal: string, listener: () => void): unknown;
	off(signal: string, listener: () => void): unknown;
}

/** The signals that end a session the person did not end. */
const ENDING = ["SIGTERM", "SIGHUP"] as const;

/** Hear whether a signal ends this session, until stopped. */
export function watchSignals(source: SignalSource): {
	signalled(): boolean;
	stop(): void;
} {
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
