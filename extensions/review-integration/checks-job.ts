/**
 * Waiting on CI as a background job.
 *
 * Without it a model waiting on checks either polls a turn at a time,
 * paying for each look, or runs `sleep` in a shell and holds the session
 * for as long as CI takes. Overnight, it does both. `review_see checks`
 * with `watch` hands the waiting to the job host instead: the call
 * returns at once, and the settled result arrives as a message of its
 * own.
 *
 * Only one watch per change at a time in a conversation, so a model that
 * asks twice does not get told twice; another conversation watching the
 * same change is told on its own bus. A look that fails is not a settled result; a run
 * of failures in a row is, and says so, since a watch that can never
 * read anything should not sit there for two hours.
 *
 * The waiting lives at the forge, not in this process, so a move to a
 * host carries it: the watch is written down as its target and how long
 * it has left, and the host binds the target again and watches on under
 * the same job id.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { withCallSignal } from "../../lib/core/exec/index.ts";
import type {
	ChecksRollup,
	ReviewTarget,
} from "../../lib/core/review/index.ts";
import { type SessionRef, sessionSlot } from "../../lib/core/session/index.ts";
import {
	type CarriedWork,
	findJobHost,
	type Job,
	type JobCarry,
} from "../../lib/jobs/index.ts";
import type { Taking } from "../../lib/jobs/take-up.ts";

/** How often to look. CI takes minutes; a tighter loop is cost with no reader. */
export const CHECKS_POLL_MS = 30_000;

/** How long to keep looking before saying the checks have not settled. */
export const CHECKS_WATCH_MS = 2 * 60 * 60 * 1000;

/** Looks in a row that may fail before the watch gives up. */
export const MAX_FAILED_LOOKS = 5;

/** The kind a carried checks watch is written down as. */
export const CHECKS_WORK = "review-checks";

/** Whether a rollup is still waiting on something. */
export function unsettled(rollup: ChecksRollup): boolean {
	return rollup.state === "pending" || rollup.state === "unreported";
}

/** How a change's checks are read and said. */
export interface ChecksReading {
	readonly read: () => Promise<ChecksRollup | null>;
	readonly render: (rollup: ChecksRollup) => string;
}

/** What watching a change's checks needs. */
export interface ChecksWatch extends ChecksReading {
	readonly bus: EventBus;
	/** The conversation watching, whose second watch of a change is refused. */
	readonly session?: SessionRef;
	/** What identifies the change, so a second watch on it is refused. */
	readonly key: string;
	/** How the change is named to the model, e.g. `Shopify/app#7`. */
	readonly label: string;
	/** What is watched, written down when a move carries the watch. */
	readonly target?: ReviewTarget;
	readonly pollMs?: number;
	readonly watchMs?: number;
	readonly now?: () => number;
}

/** A checks watch as a move writes it down. */
interface CarriedChecks extends CarriedWork {
	readonly kind: typeof CHECKS_WORK;
	readonly key: string;
	readonly label: string;
	readonly target: ReviewTarget;
	readonly startedAt: number;
	readonly watchMs: number;
}

/** Why a watch could not be started. */
export type WatchRefusal = "no-host" | "already-watching";

const WATCHING_SLOT = "agentic-harness.review-integration.checks-watching.v1";

/** The changes a conversation is watching, its own in a host. */
function watchingIn(session?: SessionRef): Set<string> {
	return sessionSlot(WATCHING_SLOT, session, () => new Set<string>());
}

/** A watch under way, which a move can stop without saying anything. */
interface Watching {
	readonly ended: () => boolean;
	readonly stop: () => void;
}

/** What a move carries of a watch, or nothing once it has ended. */
function carryOf(
	watch: Omit<ChecksWatch, "bus" | keyof ChecksReading>,
	startedAt: number,
	under: () => Watching | undefined,
): JobCarry | undefined {
	const { target } = watch;
	if (target === undefined) return undefined;
	return {
		what: () =>
			under()?.ended()
				? undefined
				: ({
						kind: CHECKS_WORK,
						key: watch.key,
						label: watch.label,
						target,
						startedAt,
						watchMs: watch.watchMs ?? CHECKS_WATCH_MS,
					} satisfies CarriedChecks),
		handed: () => under()?.stop(),
	};
}

/** Hold the waiting as a job, or say why it cannot be. */
export function watchChecks(watch: ChecksWatch): Job | WatchRefusal {
	const watching = watchingIn(watch.session);
	if (watching.has(watch.key)) return "already-watching";
	const host = findJobHost(watch.bus);
	if (host === undefined) return "no-host";
	const started = (watch.now ?? Date.now)();
	let armed: Watching | undefined;
	const carry = carryOf(watch, started, () => armed);
	const job = host.start({
		kind: "review",
		label: `checks on ${watch.label}`,
		...(carry ? { carry } : {}),
	});
	watching.add(watch.key);
	armed = arm(job, watch, started, watching);
	return job;
}

/** Look at the checks on a schedule, under `job`, until they settle. */
function arm(
	job: Job,
	watch: Omit<ChecksWatch, "bus">,
	started: number,
	watching: Set<string>,
): Watching {
	const now = watch.now ?? Date.now;
	let ended = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = () => {
		ended = true;
		clearInterval(timer);
		watching.delete(watch.key);
	};

	// Outside the calling tool's signal, which ends when the call returns;
	// every later look would be cancelled by a call long finished.
	withCallSignal(undefined, () => {
		let looking = false;
		let failed = 0;
		const done = (summary: string, failure = false) => {
			stop();
			job.finish({ summary, ...(failure ? { failed: true } : {}) });
		};
		timer = setInterval(async () => {
			if (looking || ended) return;
			looking = true;
			try {
				let rollup: ChecksRollup | null;
				try {
					rollup = await watch.read();
					failed = 0;
				} catch (error) {
					failed += 1;
					if (failed >= MAX_FAILED_LOOKS) {
						const why = error instanceof Error ? error.message : String(error);
						done(
							`Stopped watching checks on ${watch.label}: the last ${MAX_FAILED_LOOKS} looks failed (${why}). Read them again with review_see checks.`,
							true,
						);
					}
					return;
				}
				// Handed on by a move while the look was out: said there.
				if (ended) return;
				if (!rollup) {
					done(`Checks on ${watch.label} are no longer reported.`);
					return;
				}
				if (!unsettled(rollup)) {
					done(
						`Checks on ${watch.label} have settled: ${rollup.state}.\n${watch.render(rollup)}`,
					);
					return;
				}
				if (now() - started >= (watch.watchMs ?? CHECKS_WATCH_MS)) {
					done(
						`Checks on ${watch.label} were still ${rollup.state} after two hours of watching.\n${watch.render(rollup)}`,
					);
				}
			} finally {
				looking = false;
			}
		}, watch.pollMs ?? CHECKS_POLL_MS);
		timer.unref?.();

		job.signal.addEventListener("abort", stop, { once: true });
	});
	return { ended: () => ended, stop };
}

/** Whether a value is a review target as one is written down. */
function isTarget(value: unknown): value is ReviewTarget {
	if (typeof value !== "object" || value === null) return false;
	if (!("kind" in value)) return false;
	if (value.kind === "change")
		return "change" in value && typeof value.change === "object";
	return (
		(value.kind === "range" || value.kind === "stack") &&
		"repo" in value &&
		typeof value.repo === "object"
	);
}

/** Whether carried work is a checks watch this version can read. */
function isCarriedChecks(work: CarriedWork): work is CarriedChecks {
	return (
		work.kind === CHECKS_WORK &&
		typeof work.key === "string" &&
		typeof work.label === "string" &&
		typeof work.startedAt === "number" &&
		typeof work.watchMs === "number" &&
		isTarget(work.target)
	);
}

/** What taking a carried watch up needs from the process taking it. */
export interface TakingChecks {
	/** Bind the target here and say how its checks are read. */
	readonly reading: (
		target: ReviewTarget,
	) => Promise<ChecksReading | undefined>;
	readonly pollMs?: number;
	readonly now?: () => number;
	/** The conversation taking it up, else the one the call runs in. */
	readonly session?: SessionRef;
}

/**
 * Watch on, here, the checks a move carried in, under the job id it had
 * and to the deadline it started with; nothing when the work is not a
 * watch this version can read.
 */
export function takeUpChecks(
	work: CarriedWork,
	here: TakingChecks,
): Taking | undefined {
	if (!isCarriedChecks(work)) return undefined;
	const watching = watchingIn(here.session);
	const watch = {
		key: work.key,
		label: work.label,
		target: work.target,
		watchMs: work.watchMs,
		...(here.pollMs !== undefined ? { pollMs: here.pollMs } : {}),
		...(here.now !== undefined ? { now: here.now } : {}),
	};
	let armed: Watching | undefined;
	let failed = false;
	let handedOn = false;
	// Until the target is bound here, a move hands on the watch as carried.
	const binding: Watching = {
		ended: () => failed,
		stop: () => {
			handedOn = true;
			watching.delete(work.key);
		},
	};
	const carry = carryOf(watch, work.startedAt, () => armed ?? binding);
	return {
		...(carry ? { carry } : {}),
		start: (job) => {
			watching.add(work.key);
			const cannot = (why: string) => {
				failed = true;
				watching.delete(work.key);
				job.finish({
					summary: `Checks on ${work.label} were being watched when this session moved here, but they can't be read here (${why}). Read them again with review_see checks.`,
					failed: true,
				});
			};
			here.reading(work.target).then(
				(reading) => {
					if (job.signal.aborted || handedOn) return;
					if (reading === undefined) cannot("no provider serves the change");
					else
						armed = arm(
							job,
							{ ...watch, ...reading },
							work.startedAt,
							watching,
						);
				},
				(error: unknown) => {
					if (job.signal.aborted || handedOn) return;
					cannot(error instanceof Error ? error.message : String(error));
				},
			);
		},
	};
}
