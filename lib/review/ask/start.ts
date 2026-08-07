/**
 * Starting a round and walking away from it.
 *
 * A council holds the session for as long as it runs, which for the
 * models worth asking is tens of minutes. That is the cost the whole
 * of this plan has been circling: not that a round can be lost, but
 * that waiting for one is the only way to have one.
 *
 * Nothing about a reviewer actually needs the session. The supervisor
 * is its own process, it writes its answer to disk, and since #455 a
 * round can be finished from what it left there. So a round can be
 * started and abandoned on purpose: the ledger entry says it exists,
 * the reviewer directories fill up in their own time, and `collect`
 * turns them back into findings whenever somebody asks.
 *
 * What is given up is real and worth saying plainly. Nobody is
 * watching, so there is no progress to report, no wrap-up when a
 * reviewer runs long, and no retry of a model that failed to start.
 * The backstop timers inside each supervisor are the only thing
 * keeping a detached round from running until the machine is
 * rebooted, which is exactly why they were made to work first.
 */

import {
	type CouncilRequest,
	type CouncilResult,
	openingRun,
	thrownAt,
} from "./council.js";
import type { Participant } from "./identity.js";
import type { AskRun } from "./run.js";

/** What starting a round needs, which is much less than running one. */
export interface StartDeps {
	/** Dispatch one reviewer and return once it is running. */
	start(participant: Participant, prompt: string, runId: string): Promise<void>;
	now(): Date;
	/** The round exists and nobody has answered. See `CouncilDeps`. */
	opened?(run: AskRun): Promise<void>;
}

/** Start every reviewer on the roster and hand back the open round. */
export async function startCouncil(
	request: CouncilRequest,
	deps: StartDeps,
): Promise<CouncilResult> {
	const run = openingRun(request, deps.now());
	const id = run.id;

	// Before anybody is started, and here it is load-bearing rather
	// than prudent. A live council can still report what it found if
	// the ledger write fails; this one cannot. Nothing is waiting for
	// these reviewers, so the entry is the only thing that will ever
	// say they were a round rather than seven directories.
	try {
		await deps.opened?.(run);
	} catch (error) {
		return {
			run: settled(run),
			warnings: [
				`${id} was not started: the round could not be written down first (${why(error)}), and a detached round nothing has recorded cannot be collected.`,
			],
		};
	}

	// In roster order and one at a time. They overlap anyway, since
	// starting one only waits for a process to exist, and doing it in
	// order means a spawn storm of seven models hits the machine as a
	// queue rather than all at once.
	const warnings: string[] = [];
	let running = 0;
	for (const participant of request.roster.reviewers) {
		try {
			await deps.start(participant, request.prompt, id);
			running += 1;
		} catch (error) {
			// One model that will not start must not cost the others
			// their round. Recorded as a warning rather than an outcome:
			// the collect that finishes this round will find nothing in
			// its directory and say so itself.
			warnings.push(`${participant.id} could not be started: ${why(error)}.`);
		}
	}

	if (running === 0) {
		// An open round with nobody behind it is an alarm that can never
		// be answered: every collect would find nothing, forever, and
		// leaving it open is how a listing fills with rounds nobody can
		// do anything about.
		return {
			run: settled(run),
			warnings: [
				...warnings,
				`${id} was closed straight away: nobody could be started, so there will never be anything to collect.`,
			],
		};
	}

	return { run, warnings };
}

/** The same round, marked as having nothing left to wait for. */
function settled(run: AskRun): AskRun {
	const { open: _open, ...rest } = run;
	return rest;
}

/** What went wrong, in whatever words the thrower used. */
function why(error: unknown): string {
	// The same reading a waiting round gives. A detached round is the
	// one whose diagnosis is hardest to come by, since nobody watched
	// it fail and the warning is all there is, so it is the last place
	// that should say less.
	return thrownAt(error);
}
