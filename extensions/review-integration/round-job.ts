/**
 * A started round, held as a background job.
 *
 * `review_ask start` hands the session back at once, and nothing used
 * to say when the round was ready: the model polled, a turn at a time,
 * or forgot. With a job host loaded the round is held as a job, and
 * once no reviewer is left running the model is told to collect it.
 *
 * It tells rather than collects. A collect started here would race one
 * the model starts, and collecting files findings against a change,
 * which is not undoable. Saying so costs one turn and cannot double
 * anything.
 *
 * The round outlives its session by design, since everything it
 * produces is on disk. So only the person stopping the job stops the
 * round; a session ending stops the watching and nothing else. For the
 * same reason a move to a host carries the watching: it is written down
 * as the run and its reviewers, and the host watches on under the same
 * job id.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { withCallSignal } from "../../lib/core/exec/index.ts";
import {
	type CarriedWork,
	findJobHost,
	type Job,
	type JobCarry,
	jobStopOf,
} from "../../lib/jobs/index.ts";
import type { Taking } from "../../lib/jobs/take-up.ts";

/**
 * How often to look. A round runs for minutes, and each look reads a
 * lease per reviewer and may run ps, so a few seconds late is nothing
 * and a tighter loop is cost with no reader.
 */
const POLL_MS = 5000;

/** The kind a carried round's watch is written down as. */
export const ROUND_WORK = "review-round";

/** How a round is looked at and stopped. */
export interface RoundReading {
	/** Whether any reviewer in the round is still held by a live supervisor. */
	readonly isRunning: () => Promise<boolean>;
	/** Ask every reviewer in the round to stop. */
	readonly stop: () => Promise<void>;
}

/** What watching a started round needs. */
export interface StartedRound extends RoundReading {
	readonly bus: EventBus;
	readonly runId: string;
	/** One line for the job list, e.g. `council on shop/app#7`. */
	readonly label: string;
	/** The round's reviewers, by id, written down when a move carries it. */
	readonly participants?: readonly string[];
	readonly pollMs?: number;
}

/** A round's watch as a move writes it down. */
interface CarriedRound extends CarriedWork {
	readonly kind: typeof ROUND_WORK;
	readonly runId: string;
	readonly label: string;
	readonly participants: readonly string[];
}

/** What a move carries of a round's watch, or nothing once it has ended. */
function carryOf(
	runId: string,
	label: string,
	participants: readonly string[] | undefined,
	under: () => { readonly ended: boolean; stop(): void } | undefined,
): JobCarry | undefined {
	if (participants === undefined) return undefined;
	return {
		what: () =>
			under()?.ended
				? undefined
				: ({
						kind: ROUND_WORK,
						runId,
						label,
						participants,
					} satisfies CarriedRound),
		handed: () => under()?.stop(),
	};
}

/** Hold a started round as a job, or undefined when no host is loaded. */
export function watchStartedRound(round: StartedRound): Job | undefined {
	const host = findJobHost(round.bus);
	if (host === undefined) return undefined;
	let watching: ReturnType<typeof arm> | undefined;
	const carry = carryOf(
		round.runId,
		round.label,
		round.participants,
		() => watching,
	);
	const job = host.start({
		kind: "review",
		label: round.label,
		...(carry ? { carry } : {}),
	});
	watching = arm(job, round);
	return job;
}

/** Look at the round on a schedule, under `job`, until nobody runs. */
function arm(
	job: Job,
	round: RoundReading & { readonly runId: string; readonly pollMs?: number },
): { ended: boolean; stop(): void } {
	let timer: ReturnType<typeof setInterval> | undefined;
	const state = {
		ended: false,
		stop() {
			state.ended = true;
			clearInterval(timer);
		},
	};
	// Outside the start call's signal. The interval would otherwise carry
	// it, and every command a later look ran would be cancelled by a call
	// that returned long ago.
	withCallSignal(undefined, () => {
		let looking = false;
		timer = setInterval(async () => {
			if (looking || state.ended) return;
			looking = true;
			try {
				const running = await round.isRunning().catch(
					// A look that failed says nothing about the round, and
					// reading it as finished would send the model to collect
					// from under live reviewers, which collect refuses anyway.
					() => true,
				);
				// Handed on by a move while the look was out: said there.
				if (running || state.ended) return;
				state.stop();
				job.finish({
					summary: [
						`Review round ${round.runId} has no reviewer left running.`,
						`Run review_ask collect run=${round.runId} to file what they found.`,
					].join("\n"),
				});
			} finally {
				looking = false;
			}
		}, round.pollMs ?? POLL_MS);
		timer.unref?.();

		job.signal.addEventListener(
			"abort",
			() => {
				state.stop();
				// The session ending leaves the round running: its answer is on
				// disk for whoever collects it. The person or the agent stopping
				// the job stops the round.
				const stop = jobStopOf(job.signal);
				if (stop !== "person" && stop !== "agent") return;
				round.stop().catch(() => {
					// The person can still stop it with review_ask stop, and
					// a watcher has nobody to report a failure to.
				});
			},
			{ once: true },
		);
	});
	return state;
}

/** Whether carried work is a round's watch this version can read. */
function isCarriedRound(work: CarriedWork): work is CarriedRound {
	const participants = work.participants;
	return (
		work.kind === ROUND_WORK &&
		typeof work.runId === "string" &&
		typeof work.label === "string" &&
		Array.isArray(participants) &&
		participants.every((id) => typeof id === "string")
	);
}

/**
 * Watch on, here, the round a move carried in, under the job id it had;
 * nothing when the work is not a round's watch this version can read.
 */
export function takeUpRound(
	work: CarriedWork,
	reading: (
		runId: string,
		participants: readonly string[],
	) => RoundReading & { readonly pollMs?: number },
): Taking | undefined {
	if (!isCarriedRound(work)) return undefined;
	let watching: ReturnType<typeof arm> | undefined;
	const carry = carryOf(
		work.runId,
		work.label,
		work.participants,
		() => watching,
	);
	return {
		...(carry ? { carry } : {}),
		start: (job) => {
			watching = arm(job, {
				runId: work.runId,
				...reading(work.runId, work.participants),
			});
		},
	};
}
