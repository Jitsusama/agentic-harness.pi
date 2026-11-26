/**
 * Whether another roster round still runs on this machine, so a Mac
 * can start its rounds one at a time.
 *
 * A Mac's room reads its memory only as it stands: a round's reviewers
 * load a minute or more after it starts, so a second round started
 * beside a first read the room the first had not yet taken. On 26
 * November two rounds ran at once on the work Mac twice in ten minutes
 * (15:06 and 15:12), each started on a reading the other was about to
 * spend, and the Mac fell under 30% free. Velocity runs the Mac one
 * roster round at a time (1OGSE7), and this is what holds a start to it.
 *
 * A round is read from the folders its reviewers leave under the
 * transcripts' `runs`, judged by the same supervisor lease the collect
 * path reads, so a round counts as running exactly while a collect
 * would refuse it. A judge and an audit ask one participant each and
 * are not counted, as the start line doesn't count them.
 */

import { readdir, stat } from "node:fs/promises";
import { rosterStartOf } from "../../lib/core/review/ask/start-spacing.ts";
import { type TickFacts, tickFacts } from "../../lib/internal/process-ticks.ts";
import { ReviewerArtifactsStore } from "../../lib/subagent/artifacts.ts";
import {
	STARTING_FOR_MS,
	supervisorStanding,
} from "../../lib/subagent/lease.ts";

/**
 * How far back a round's start is looked for. A reviewer's wall is an
 * hour on this machine's roster and a round's reviewers start together,
 * so a round older than this has ended or been given up on; reading
 * every round on disk would cost a look for nothing.
 */
export const RUNNING_LOOK_BACK_MS = 3 * 60 * 60_000;

/** A round still running here, and how many of its reviewers are yet to answer. */
export interface RunningRound {
	readonly runId: string;
	readonly reviewersRunning: number;
}

/**
 * The newest roster round under `stateDir` that still runs on this
 * machine, or nothing when none does. A round whose folder holds no
 * reviewer yet counts as running while it is young, as a supervisor's
 * own missing lease does, since its reviewers are being handed out.
 */
export async function rosterRoundRunning(
	stateDir: string,
	facts: TickFacts = tickFacts,
	now: number = Date.now(),
): Promise<RunningRound | undefined> {
	const store = new ReviewerArtifactsStore(stateDir);
	const recent = (await namesIn(store.runsDir))
		.map((name) => ({ name, at: rosterStartOf(name) }))
		.filter(
			(run): run is { name: string; at: number } =>
				run.at !== undefined && now - run.at < RUNNING_LOOK_BACK_MS,
		)
		.sort((a, b) => b.at - a.at);
	for (const run of recent) {
		const { reviewersDir } = store.rootPaths(run.name);
		const reviewers = await namesIn(reviewersDir);
		if (reviewers.length === 0) {
			if (await youngerThan(reviewersDir, run.at, STARTING_FOR_MS, now)) {
				return { runId: run.name, reviewersRunning: 0 };
			}
			continue;
		}
		let running = 0;
		for (const reviewerId of reviewers) {
			const standing = await supervisorStanding(
				store,
				run.name,
				reviewerId,
				facts,
				now,
			);
			if (standing.kind === "running" || standing.kind === "starting") {
				running += 1;
			}
		}
		if (running > 0) return { runId: run.name, reviewersRunning: running };
	}
	return undefined;
}

/** Why a start waits for a round still running, said for its answer. */
export function runningSaid(round: RunningRound): string {
	const who =
		round.reviewersRunning === 0
			? "its reviewers are still being handed out"
			: `${round.reviewersRunning} of its reviewers ${round.reviewersRunning === 1 ? "is" : "are"} still running`;
	return `${round.runId} still runs on this Mac (${who}), and a Mac starts one roster round at a time`;
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
