/**
 * The bash calls a child's park watches beside those its stop said it
 * carried: each one the conversation recorded as it ran
 * (lib/internal/shell/kept-jobs.ts) whose end it hasn't said, and which
 * neither its stop's carry nor an earlier try names. Its park
 * (parking.ts) records them with the rest, so it wakes once they end,
 * at once for one already ended. On 26 November at 00:25 a roll parked
 * 15277F02 while its `devx ci drill` ran, its stop saying no carry, and
 * the call ran on unwatched, its result waiting half an hour for the
 * park's own wake. The child's process ends as it parks, so its next
 * one takes such a call up from its record as it resumes, as after a
 * kill. A shared host, running on, holds its conversations' records, so
 * it reads none.
 */
import type { CarriedShell } from "../../lib/internal/shell/carried.ts";
import { recordedKeptJobs } from "../../lib/internal/shell/kept-jobs.ts";
import { carriedCalls } from "./parked-calls.ts";

/**
 * How long a park waits on the read of what its conversation recorded
 * before it parks on what its stop said: a few small files, which a
 * disk under load returns in seconds, never a park held for minutes.
 */
export const RECORDED_READ_MS = 10_000;

/**
 * The bash calls `sessionId` recorded as they ran and whose end isn't
 * said yet, from the kept folder (`folder` in a test), read off the
 * thread: what a child's park watches beside those its stop said.
 */
export async function recordedCallsOf(
	sessionId: string,
	folder?: string,
): Promise<readonly CarriedShell[]> {
	const jobs = await (folder === undefined
		? recordedKeptJobs(sessionId)
		: recordedKeptJobs(sessionId, folder));
	return jobs.map((job) => job.work);
}

/**
 * Of the calls `reading` answers, each once, those that neither the
 * carry recorded in `folder` nor `held` names. Throws where the reading
 * fails or takes longer than `ms`, so the park goes on with what its
 * stop said.
 */
export async function untoldCalls(
	reading: Promise<readonly CarriedShell[]>,
	place: {
		readonly folder: string;
		readonly held: readonly CarriedShell[];
		readonly ms: number;
		readonly report: (error: unknown) => void;
	},
): Promise<CarriedShell[]> {
	const recorded = await withinRead(reading, place.ms);
	if (recorded.length === 0) return [];
	const known = new Set(
		[...toldIn(place.folder, place.report), ...place.held].map(
			(work) => work.keep,
		),
	);
	return recorded.filter((work) => {
		if (known.has(work.keep)) return false;
		known.add(work.keep);
		return true;
	});
}

/**
 * The calls a stop's carry recorded in `folder`; none where that record
 * can't be read, so the write of the untold ones is still tried and,
 * failing, wakes the conversation and holds its calls awake for a while.
 */
function toldIn(
	folder: string,
	report: (error: unknown) => void,
): readonly CarriedShell[] {
	try {
		return carriedCalls(folder);
	} catch (error) {
		report(error);
		return [];
	}
}

/** `reading`, refused once it takes longer than `ms`. */
async function withinRead<T>(reading: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`the recorded calls took over ${ms} ms to read; parking on what its stop said`,
					),
				),
			ms,
		);
		timer.unref?.();
	});
	try {
		return await Promise.race([reading, late]);
	} finally {
		clearTimeout(timer);
	}
}
