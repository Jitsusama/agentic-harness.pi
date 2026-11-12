/**
 * How a round's watch reads the round it waits on: from the run's
 * record, which its reviewers' supervisors keep whether or not the
 * session that started them is still there. So a watch a move carried
 * in reads the round the same way the one that started it did.
 */

import { ReviewerArtifactsStore } from "../../lib/subagent/index.ts";
import { runArtifactDir } from "./engine.ts";
import { whyNotYet } from "./reviewer.ts";
import type { RoundReading } from "./round-job.ts";

/** A run as its record names it: its id and its reviewers'. */
interface RunNamed {
	readonly id: string;
	readonly participants: readonly { readonly id: string }[];
}

/** How a round's watch looks at the round and stops it, from its record. */
export function roundReading(
	artifacts: ReviewerArtifactsStore,
	run: RunNamed,
): RoundReading {
	return {
		isRunning: async () => (await whyNotYet(artifacts, run)) !== undefined,
		stop: () =>
			artifacts.requestRunCancellation(
				run.id,
				`Stopped from the job list on ${new Date().toISOString()}.`,
			),
	};
}

/**
 * How a round's watch a move carried into this session reads its
 * round, named by its id and its reviewers' (`ask-tool.ts` takes it
 * up).
 */
export function carriedRoundReading(
	id: string,
	participants: readonly string[],
): RoundReading {
	return roundReading(new ReviewerArtifactsStore(runArtifactDir()), {
		id,
		participants: participants.map((participant) => ({ id: participant })),
	});
}
