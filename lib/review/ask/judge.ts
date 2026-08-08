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

import { askOne, type CouncilDeps } from "./council.js";
import { alsoRecorded, harvestFindings } from "./harvest.js";
import { type Participant, participantIdentity } from "./identity.js";
import {
	type AskRun,
	newRunId,
	type ParticipantOutcome,
	whatItRead,
} from "./run.js";

/** Who consolidates, and what they are told. */
export interface JudgeRequest {
	judge: Participant;
	prompt: string;
	/** Distinguishes two rounds started in the same millisecond. */
	seq: number;
	/** Commit under review, which anchors claim when the tree is it. */
	witness?: string;
	/** Said when the tree the reviewers read was not that commit. */
	unpinned?: string;
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

	// Reported, which this round did not used to be. A judge is one
	// participant, so it never went through the roster path that does the
	// reporting, and nothing here did it instead: a consolidation of sixty
	// findings ran to completion showing no sign of life. `askOne` also
	// folds a thrown runner into a reported failure, which is why the
	// try/catch that used to say so is gone rather than kept beside it.
	const answer = await askOne(request.judge, request.prompt, id, deps);

	const outcome: ParticipantOutcome = await (async () => {
		if ("failure" in answer) {
			return {
				participantId: request.judge.id,
				findingIds: [],
				failure: answer.failure,
			};
		}

		const origin = {
			kind: "judge" as const,
			runId: id,
			reviewerId: request.judge.id,
		};
		// A judge writes findings down as it goes for the same reason a
		// reviewer does, and it runs against every reviewer's answer at
		// once, so it is the participant most likely to run long.
		//
		// Only as a fallback, though, unlike a reviewer's. A judge's
		// job is deciding what survives, so a finding it recorded early
		// and left out of its consolidation was dropped on purpose, and
		// unioning would overrule the one participant paid to choose.
		// When it produced no consolidation at all, what it wrote down
		// on the way is all there is.
		const said = harvestFindings(answer.text, origin, request);
		const harvest =
			said.findings.length > 0
				? said
				: alsoRecorded(said, answer.recorded, origin, request);
		for (const warning of [...harvest.warnings, ...(answer.notes ?? [])]) {
			warnings.push(`${request.judge.id}: ${warning}`);
		}

		const recorded =
			harvest.findings.length === 0 ? [] : await deps.record(harvest.findings);
		// Counted from what was filed rather than from the answer, the same
		// rule the roster rounds settle by: a finding that would not parse
		// never became one, and saying otherwise on the way past would
		// overcount the round in the only place anyone sees it live.
		deps.progress?.recorded(request.judge.id, recorded.length);

		return {
			participantId: request.judge.id,
			findingIds: recorded.map((finding) => finding.id),
			// A judge can be stopped exactly as a reviewer can, and a
			// round that does not record it reports the same lie the
			// council round was fixed for: a participant taken away
			// mid-sentence, filed as one that answered.
			...(answer.stopped === undefined ? {} : { stopped: answer.stopped }),
			...(answer.answerPath === undefined
				? {}
				: { answerPath: answer.answerPath }),
			...(answer.usage === undefined ? {} : { usage: answer.usage }),
		};
	})();

	// The board is about to be replaced by the round's own answer, and a
	// stale one outlives the thing it described.
	deps.progress?.finish();

	return {
		run: {
			id,
			round: "judge",
			startedAt: startedAt.toISOString(),
			participants: [participantIdentity("judge", request.judge)],
			outcomes: [outcome],
			// The same commit the findings above are anchored against,
			// said on the round as well. It was used and not recorded,
			// so every judge round in the ledger could anchor a finding
			// honestly and still not say what it had judged: sixteen of
			// sixteen, beside councils that all could.
			//
			// The ledger is the reason, and the only one. A judge round
			// is never left open, so no collect will read this, and
			// claiming otherwise would be justifying a fact with a path
			// that cannot be taken. What it answers is a reader asking
			// what a round was formed against, which until now the
			// record could not say for three kinds out of four.
			...whatItRead(request),
		},
		warnings,
	};
}
