/**
 * Consolidating what a council said.
 *
 * A judge is one participant asked once, so this is much simpler
 * than a council, and it is a separate round rather than a council of
 * one for two reasons a reader downstream depends on.
 *
 * Its findings carry origin kind `judge`, which is what tells anyone
 * reading them later that this pass consolidated rather than
 * discovered. And its participant holds role `judge`, which is what
 * the identity ledger uses to refuse letting one id be both: a reader
 * of the origins would have no way to tell the consolidation from the
 * thing it consolidated.
 */

import type { CouncilDeps } from "./council.js";
import { harvestFindings } from "./harvest.js";
import { type Participant, participantIdentity } from "./identity.js";
import { type AskRun, newRunId, type ParticipantOutcome } from "./run.js";

/** Who consolidates, and what they are told. */
export interface JudgeRequest {
	judge: Participant;
	prompt: string;
	/** Distinguishes two rounds started in the same millisecond. */
	seq: number;
	/** Commit the findings' anchors are formed against. */
	witness?: string;
}

/** The run, and anything worth telling the caller. */
export interface JudgeResult {
	run: AskRun;
	warnings: string[];
}

/** Ask a judge to consolidate, and record what it concluded. */
export async function runJudge(
	request: JudgeRequest,
	deps: CouncilDeps,
): Promise<JudgeResult> {
	const startedAt = deps.now();
	const id = newRunId("judge", startedAt, request.seq);
	const warnings: string[] = [];

	const answer = await (async () => {
		try {
			return await deps.ask(request.judge, request.prompt);
		} catch (error) {
			// A runner that rejects and one that reports a failure are
			// the same event, and the caller should not have to care
			// which shape it arrived in.
			return {
				failure: error instanceof Error ? error.message : String(error),
			};
		}
	})();

	const outcome: ParticipantOutcome = await (async () => {
		if ("failure" in answer) {
			return {
				participantId: request.judge.id,
				findingIds: [],
				failure: answer.failure,
			};
		}

		const harvest = harvestFindings(
			answer.text,
			{ kind: "judge", runId: id, reviewerId: request.judge.id },
			request.witness,
		);
		for (const warning of harvest.warnings) {
			warnings.push(`${request.judge.id}: ${warning}`);
		}

		const recorded =
			harvest.findings.length === 0 ? [] : await deps.record(harvest.findings);

		return {
			participantId: request.judge.id,
			findingIds: recorded.map((finding) => finding.id),
			...(answer.usage === undefined ? {} : { usage: answer.usage }),
		};
	})();

	return {
		run: {
			id,
			round: "judge",
			startedAt: startedAt.toISOString(),
			participants: [participantIdentity("judge", request.judge)],
			outcomes: [outcome],
		},
		warnings,
	};
}
