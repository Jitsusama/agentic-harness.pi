/**
 * Who is tracing, and the fact that only one of us can be.
 *
 * Tracing is a browser-wide facility rather than a per-page one.
 * Measured: a second Tracing.start is refused with "Tracing has
 * already been started (possibly in another tab)", and a recording
 * begun for one session contains another session's work. So the
 * limit is real, and it is shared.
 *
 * That makes two things this module's job. It hands out the single
 * permit, so a second session is told no rather than crashing into
 * a protocol error. And it remembers who holds it, because every
 * page in the browser is paying for a recording while it runs and
 * a reader wondering why should be able to find out.
 */

import type { TraceProfile } from "../perf/trace.js";

/** A recording in progress, and who asked for it. */
export interface Recording {
	/** The session that started it. */
	readonly session: string;
	readonly profiles: readonly TraceProfile[];
	readonly startedAt: Date;
}

/** Why a recording could not be started. */
export interface RecordingRefused {
	readonly refusal: string;
	/** The recording already running. */
	readonly held: Recording;
}

let current: Recording | undefined;

/**
 * Claim the single recording permit.
 *
 * Refuses rather than waiting. A traced action that silently
 * queued behind another session's recording would report a
 * duration that included the wait, which is a worse answer than
 * being told the facility is busy.
 */
export function claimRecording(
	session: string,
	profiles: readonly TraceProfile[],
): Recording | RecordingRefused {
	if (current !== undefined) {
		const since = current.startedAt.toISOString().slice(11, 19);
		return {
			refusal:
				`Session ${current.session} has been recording a trace since ` +
				`${since}. The browser allows one at a time, so this one ` +
				"cannot start until that finishes.",
			held: current,
		};
	}
	current = { session, profiles, startedAt: new Date() };
	return current;
}

/** Release the permit. Safe to call when nothing is held. */
export function releaseRecording(): void {
	current = undefined;
}

/** The recording in progress, for any session that wants to report it. */
export function recordingInProgress(): Recording | undefined {
	return current;
}

/**
 * How a session's status should mention a live recording.
 *
 * Every session says this, not just the one that started it,
 * because every page in the browser is being instrumented while
 * it runs. A reader looking at an unexpectedly slow page should
 * find the reason in front of them.
 */
export function describeRecording(
	recording: Recording | undefined,
	viewer: string,
): string | undefined {
	if (recording === undefined) return undefined;
	const whose =
		recording.session === viewer
			? "this session"
			: `session ${recording.session}`;
	return (
		`Tracing is on, started by ${whose} at ` +
		`${recording.startedAt.toISOString().slice(11, 19)} ` +
		`(${recording.profiles.join(" and ")}). Every page in the browser ` +
		"is being instrumented while it runs."
	);
}
