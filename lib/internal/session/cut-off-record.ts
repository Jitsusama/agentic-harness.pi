/**
 * The record a session leaves when something other than its person ends
 * its run or the jobs it waited on.
 *
 * The job workflow leaves it as a signal or an uncaught error ends a
 * session, and reads it on the session's return to say where it stopped
 * (extensions/job-workflow/cut-off.ts). A move back to plain pi leaves
 * it too, as it ends a run it waited on too long
 * (extensions/mesh-workflow/moving.ts), so the shape lives here, where
 * both reach it, rather than in either extension.
 *
 * A hosted conversation's host ends a run durable refused to start, as
 * one asked while it carries a cut-off run on, with an error answer of
 * its own, which says nothing of how the carried run went. The host
 * marks that answer here, so the job workflow passes over it when it
 * reads the carried run's end: it used to know one by durable's words
 * ("Conversation ID is busy"), which any change of durable's could break
 * silently.
 */

import { isRecord } from "../record.ts";

/** The entry a session's cut-off end leaves when work was under way. */
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
	/** Whether the host that ended it carries that run on at the next start. */
	readonly runCarried?: boolean;
	/** The jobs still running, which died with it. */
	readonly jobs: readonly CutJob[];
	/** What ended it, when not the machine: `a move to plain pi ...`. */
	readonly by?: string;
}

/**
 * The record a move leaves as it ends the run it waited on, `by` saying
 * what ended it: a run under way and no job, since a move carries its
 * jobs.
 */
export function cutByMove(by: string, now: number): CutOff {
	return { at: now, running: true, jobs: [], by };
}

/** The field a host sets on an answer it made for a run it never admitted. */
export const REFUSED_RUN_FIELD = "refusedByHost";

/** Mark `message` as the answer a host made for a run it never admitted. */
export function markedRefused<T extends object>(
	message: T,
): T & { readonly [REFUSED_RUN_FIELD]: true } {
	return { ...message, [REFUSED_RUN_FIELD]: true };
}

/** Whether `message` is an answer its host made for a run it never admitted. */
export function isRefusedRun(message: unknown): boolean {
	return isRecord(message) && message[REFUSED_RUN_FIELD] === true;
}
