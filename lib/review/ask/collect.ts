import type { AskAnswer, CouncilDeps, CouncilResult } from "./council.js";
import { recordReply } from "./council.js";
import { settleReplies } from "./progress.js";
import type { AskRun, ParticipantOutcome } from "./run.js";

/**
 * What collecting a round needs, which is less than running one.
 *
 * No `ask`, because nobody is being asked: the answers already exist.
 * No `opened`, because the round was written down when it opened and
 * that is how it was found. No clock, because a collected round keeps
 * the time it started rather than the time somebody noticed it.
 */
export type CollectDeps = Pick<CouncilDeps, "record"> &
	Partial<Pick<CouncilDeps, "progress">>;

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
			return recordReply(
				{ participant: { id: participant.id }, answer },
				{
					runId: run.id,
					...(run.witness === undefined ? {} : { witness: run.witness }),
				},
				deps,
				warnings,
			);
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
	const { open: _settled, ...rest } = run;
	return { run: { ...rest, outcomes }, warnings };
}
