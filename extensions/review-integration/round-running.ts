/**
 * Which roster rounds still run on this machine, and whether a Mac
 * may start another beside them.
 *
 * A Mac's room reads its memory only as it stands: a round's reviewers
 * load a minute or more after it starts, so a second round started
 * beside a first read the room the first had not yet taken. On 26
 * November two rounds ran at once on the work Mac twice in ten minutes
 * (15:06 and 15:12), each started on a reading the other was about to
 * spend, and the Mac fell under 30% free. So a Mac starts one roster
 * round at a time unless its config's `review.mac.roundsAtOnce` lets
 * it run more (1OGSE7), and even then a further round starts only once
 * every round running is {@link SETTLED_AFTER_MS} in, so their
 * reviewers have loaded and the reading includes them, and only on a
 * reading of at least {@link LEAST_FREE_FOR_ANOTHER_PERCENT}% free. The
 * line's spacing between starts still covers a round that took its
 * start and has yet to leave its folder, so two waiting rounds never
 * both pass on one count.
 *
 * A round is read from the folders its reviewers leave under the
 * transcripts' `runs`, judged by the same supervisor lease the collect
 * path reads, so a round counts as running exactly while a collect
 * would refuse it. A judge and an audit ask one participant each and
 * are not counted, as the start line doesn't count them. A retry asks
 * one reviewer into a roster round's folder, and does count while it
 * runs inside that round's look back, since its reviewer loads here like any other. So does a round
 * whose reviewers run on another machine: its supervisors run here,
 * and nothing on disk says where a reviewer's model ran.
 */

import { readdir, stat } from "node:fs/promises";
import { rosterStartOf } from "../../lib/core/review/ask/start-spacing.ts";
import {
	askedOnceWithTicks,
	type TickFacts,
	tickFacts,
} from "../../lib/internal/process-ticks.ts";
import { ReviewerArtifactsStore } from "../../lib/subagent/artifacts.ts";
import {
	STARTING_FOR_MS,
	supervisorStanding,
} from "../../lib/subagent/lease.ts";

/**
 * How long a round may hold a Mac's starts, however its supervisors
 * stand. A round's reviewers start together, and the longest wall on
 * the work Mac's rosters is 90 minutes, so a round older than two hours
 * has ended or wedged: a supervisor alive past its own wall would
 * otherwise hold every Mac round behind it. Reading every round on
 * disk would cost a look for nothing besides.
 */
export const RUNNING_LOOK_BACK_MS = 2 * 60 * 60_000;

/**
 * How long every running round must have run before a Mac starts
 * another beside it: a round's reviewers load a minute or more after
 * it starts, so by three minutes they have, and the memory reading
 * includes what they take.
 */
export const SETTLED_AFTER_MS = 3 * 60_000;

/**
 * The least free memory, as `kern.memorystatus_level` reads it, on
 * which a Mac starts a round beside one already running. A round takes
 * 3 to 4 GB, and the 35% a lone round starts on leaves no room for a
 * second's on top of the first's.
 */
export const LEAST_FREE_FOR_ANOTHER_PERCENT = 60;

/** A round still running here, and how many of its reviewers are yet to answer. */
export interface RunningRound {
	readonly runId: string;
	readonly reviewersRunning: number;
	/** How long it has run, so a wait behind a wedged round shows as one. */
	readonly runningMs?: number;
}

/** Which condition holds a start beside the rounds already running. */
export type RoundsHeldBy = "count" | "young" | "free";

/** A start the rounds already running hold, and why, said for its answer. */
export interface RoundsHeld {
	readonly by: RoundsHeldBy;
	readonly said: string;
}

/**
 * Every roster round under `stateDir` that still runs on this machine,
 * newest first, or none. A round whose folder holds no reviewer yet
 * counts as running while it is young, as a supervisor's own missing
 * lease does, since its reviewers are being handed out.
 */
export async function rosterRoundsRunning(
	stateDir: string,
	facts: TickFacts = tickFacts,
	now: number = Date.now(),
): Promise<RunningRound[]> {
	const store = new ReviewerArtifactsStore(stateDir);
	// One process listing for every reviewer this look reads, not one each.
	const once = askedOnceWithTicks(facts);
	const recent = (await namesIn(store.runsDir))
		.map((name) => ({ name, at: rosterStartOf(name) }))
		.filter(
			(run): run is { name: string; at: number } =>
				run.at !== undefined && now - run.at < RUNNING_LOOK_BACK_MS,
		)
		.sort((a, b) => b.at - a.at);
	const running: RunningRound[] = [];
	for (const run of recent) {
		const round = await stillRunning(store, run, once, now);
		if (round !== undefined) running.push(round);
	}
	return running;
}

/**
 * What holds a start on a Mac running `running`, where it may run
 * `atOnce` roster rounds at a time, or nothing when it may start: the
 * count once it is reached; below it, a round not yet
 * {@link SETTLED_AFTER_MS} in; then a free reading under
 * {@link LEAST_FREE_FOR_ANOTHER_PERCENT}%, or none to be had. With no
 * round running nothing here holds it, and `freePercent` is asked only
 * once the count and the ages let a start through.
 */
export async function roundsHeld(
	running: readonly RunningRound[],
	atOnce: number,
	freePercent: () => Promise<number | undefined>,
): Promise<RoundsHeld | undefined> {
	if (running.length === 0) return undefined;
	if (running.length >= atOnce) {
		return { by: "count", said: countSaid(running, atOnce) };
	}
	// A round whose age is unknown reads as young, to hold rather than guess.
	const young = running.find(
		(round) => (round.runningMs ?? 0) < SETTLED_AFTER_MS,
	);
	if (young !== undefined) {
		return {
			by: "young",
			said: `${young.runId} has run ${minutesOf(young.runningMs ?? 0)} minutes on this Mac, and another round starts beside it only once every round running is ${SETTLED_AFTER_MS / 60_000} minutes in, when their reviewers have loaded`,
		};
	}
	const free = await freePercent();
	if (free === undefined || free < LEAST_FREE_FOR_ANOTHER_PERCENT) {
		const reads =
			free === undefined
				? "this Mac's free memory can't be read"
				: `this Mac reads ${free}% free`;
		return {
			by: "free",
			said: `${reads}, and another round starts beside ${running.length} running only at ${LEAST_FREE_FOR_ANOTHER_PERCENT}% free or more`,
		};
	}
	return undefined;
}

/** Why a start waits for a round still running, said for its answer. */
export function runningSaid(round: RunningRound): string {
	const who =
		round.reviewersRunning === 0
			? "its reviewers are still being handed out"
			: `${round.reviewersRunning} of its reviewers ${round.reviewersRunning === 1 ? "is" : "are"} still running`;
	const minutes =
		round.runningMs === undefined
			? ""
			: `, ${minutesOf(round.runningMs)} minutes in`;
	return `${round.runId} still runs on this Mac (${who}${minutes}), and a Mac starts one roster round at a time`;
}

/**
 * Why a start waits once the rounds running number `atOnce`: as a Mac
 * has always said it of one round, or naming them all.
 */
function countSaid(running: readonly RunningRound[], atOnce: number): string {
	const [only] = running;
	if (atOnce <= 1 && running.length === 1 && only !== undefined) {
		return runningSaid(only);
	}
	const names = running.map((round) => round.runId).join(", ");
	return `${running.length} roster rounds still run on this Mac (${names}), and it starts at most ${atOnce} at a time`;
}

/** The round `run` as its reviewers stand, when it still runs here. */
async function stillRunning(
	store: ReviewerArtifactsStore,
	run: { readonly name: string; readonly at: number },
	once: TickFacts,
	now: number,
): Promise<RunningRound | undefined> {
	const { reviewersDir } = store.rootPaths(run.name);
	const reviewers = await namesIn(reviewersDir);
	const runningMs = now - run.at;
	if (reviewers.length === 0) {
		const starting = await youngerThan(
			reviewersDir,
			run.at,
			STARTING_FOR_MS,
			now,
		);
		return starting
			? { runId: run.name, reviewersRunning: 0, runningMs }
			: undefined;
	}
	let reviewersRunning = 0;
	for (const reviewerId of reviewers) {
		const standing = await supervisorStanding(
			store,
			run.name,
			reviewerId,
			once,
			now,
		);
		if (standing.kind === "running" || standing.kind === "starting") {
			reviewersRunning += 1;
		}
	}
	return reviewersRunning > 0
		? { runId: run.name, reviewersRunning, runningMs }
		: undefined;
}

/** Whole minutes in `ms`, never under none. */
function minutesOf(ms: number): number {
	return Math.max(0, Math.floor(ms / 60_000));
}

/** The folder names in `folder`, or none when it can't be read. */
async function namesIn(folder: string): Promise<string[]> {
	try {
		const entries = await readdir(folder, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((e) => e.name);
	} catch {
		// No folder yet means no round, or no reviewer, has started there.
		return [];
	}
}

/**
 * Whether a round's folder is younger than `windowMs`: its reviewers'
 * folder when it has one, else the start its name says.
 */
async function youngerThan(
	folder: string,
	startedAt: number,
	windowMs: number,
	now: number,
): Promise<boolean> {
	let since = startedAt;
	try {
		const { birthtimeMs, mtimeMs } = await stat(folder);
		since = birthtimeMs > 0 ? birthtimeMs : mtimeMs;
	} catch {
		// No reviewers' folder yet: the name's start is all there is.
	}
	return now - since < windowMs;
}
