import type { AskAnswer, CouncilDeps, CouncilResult } from "./council.js";
import { recordReply } from "./council.js";
import { settleReplies } from "./progress.js";
import type { AskRun, ParticipantOutcome } from "./run.js";
import { whatItRead } from "./run.js";

/**
 * What collecting a round needs, which is less than running one.
 *
 * No `ask`, because nobody is being asked: the answers already exist.
 * No `opened`, because the round was written down when it opened and
 * that is how it was found. No clock, because a collected round keeps
 * the time it started rather than the time somebody noticed it.
 */
export type CollectDeps = Pick<CouncilDeps, "record"> &
	Partial<Pick<CouncilDeps, "progress">> & {
		/**
		 * Persist the round as each participant is filed.
		 *
		 * Collecting writes findings against the change and nothing
		 * undoes that. Filing every one of them and recording the round
		 * once at the end leaves a window where the findings exist and
		 * the round still says nobody collected it, and the only thing
		 * anybody can do with such a round is collect it again, which
		 * files all of them a second time.
		 *
		 * Written after each participant instead, so an interrupted
		 * collect leaves durable progress and the next one skips what is
		 * already there. Optional, and a caller that omits it has the
		 * window back.
		 */
		progressed?(run: AskRun): Promise<void>;
	};

/** Said for a participant whose answer is not on disk. */
const NOTHING_LEFT =
	"nothing was left on disk to collect, so whatever this reviewer found is gone";

/**
 * Finish a round from what its reviewers left behind.
 *
 * The round that opened is the round that settles: its id, its start
 * time, its participants and their order all come off the record
 * rather than being minted again, because a collected round is the
 * same round arriving late and a new id would make it a second one.
 *
 * Every answer goes through the same recording path a live reply
 * takes, so a finding collected an hour afterwards is numbered,
 * anchored and warned about exactly as it would have been at the time.
 */
export async function collectRound(
	run: AskRun,
	answers: ReadonlyMap<string, AskAnswer>,
	deps: CollectDeps,
): Promise<CouncilResult> {
	const warnings: string[] = [];
	const held = new Map(run.outcomes.map((one) => [one.participantId, one]));
	const outcomes = await settleReplies(
		run.participants,
		async (participant): Promise<ParticipantOutcome> => {
			// An outcome the round already has is left alone. A retry
			// can substitute one into an unsettled round before anybody
			// collects it, and those findings are in the store already:
			// recording them again would file one observation twice and
			// number it twice.
			const already = held.get(participant.id);
			if (already !== undefined) return already;

			const answer = answers.get(participant.id);
			if (answer === undefined) {
				return {
					participantId: participant.id,
					findingIds: [],
					failure: NOTHING_LEFT,
				};
			}
			const outcome = await recordReply(
				{ participant: { id: participant.id }, answer },
				// The whole fact, not the commit alone. Spreading half of
				// it here was how the collect path went on stamping the
				// change's head on findings harvested off a round that had
				// read something else, which is the path most likely to be
				// unpinned in the first place.
				{ runId: run.id, ...whatItRead(run) },
				deps,
				warnings,
			);
			// Held straight away, so the next turn of this loop cannot
			// lose what this one paid for.
			held.set(outcome.participantId, outcome);
			try {
				await deps.progressed?.({ ...run, outcomes: [...held.values()] });
			} catch {
				// The findings are recorded either way. A ledger that will
				// not take an interim write is reported once at the end
				// rather than seven times from in here.
			}
			return outcome;
		},
		(outcome) => ({
			participantId: outcome.participantId,
			findings: outcome.findingIds.length,
		}),
		deps.progress,
	);

	// Collecting a round is what finishing it means, so the mark comes
	// off. Leaving it would keep the alarm up for work that has now
	// been recovered, and an alarm nobody can answer stops being read.
	//
	// Unless nothing was recovered. Settling then closes the file on a
	// round whose work may be sitting somewhere else entirely, and the
	// mark is one-way: nothing sets it again. The likeliest cause of
	// finding nothing is looking in the wrong place, a different state
	// directory or another machine, which is exactly when the record
	// has to survive.
	if (answers.size === 0) {
		return {
			run: { ...run, outcomes },
			warnings: [
				...warnings,
				`Nothing was found on disk for any of the ${run.participants.length} participants, so ${run.id} is left open rather than settled. Its transcripts may have been swept, or may be under a different state directory or on another machine.`,
			],
		};
	}
	const { open: _settled, ...rest } = run;
	return { run: { ...rest, outcomes }, warnings };
}
