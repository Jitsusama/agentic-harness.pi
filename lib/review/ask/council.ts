/**
 * Asking a whole roster at once.
 *
 * Participants are asked concurrently, because the wait is the whole
 * cost and there is no reason for six models to queue. Their
 * findings are recorded **in roster order** regardless of who
 * answered first, because people say finding numbers out loud and a
 * number that depends on which model happened to be quickest would
 * make the same run describe itself differently every time.
 *
 * Nothing one participant does can take the round down. A failure
 * reported by the runner and an exception thrown by it are the same
 * event seen from two sides, and both are recorded against that
 * participant so the rest of the round survives. Losing five good
 * reviews to one unavailable model would be the worst possible
 * trade, given what a round costs to run.
 */

import type { Finding } from "../finding.js";
import { harvestFindings } from "./harvest.js";
import {
	type Participant,
	type ParticipantIdentity,
	participantIdentity,
} from "./identity.js";
import type { Roster } from "./roster.js";
import {
	type AskRound,
	type AskRun,
	type AskUsage,
	newRunId,
	type ParticipantOutcome,
} from "./run.js";

/** What came back from asking one participant. */
export type AskAnswer =
	| { text: string; usage?: AskUsage }
	| { failure: string };

/** The impure things asking needs. */
export interface CouncilDeps {
	/** Run one participant against the prompt. */
	ask(participant: Participant, prompt: string): Promise<AskAnswer>;
	/** Put findings on the change, numbering them as they land. */
	record(findings: Omit<Finding, "id">[]): Promise<Finding[]>;
	now(): Date;
}

/** What to ask, of whom. */
export interface CouncilRequest {
	roster: Roster;
	prompt: string;
	/** Distinguishes two rounds started in the same millisecond. */
	seq: number;
	/** Commit the findings' anchors are formed against. */
	witness?: string;
	/** Defaults to a council round. */
	round?: AskRound;
}

/** The run, and anything worth telling the caller. */
export interface CouncilResult {
	run: AskRun;
	warnings: string[];
}

/** What one participant came back with, before it was recorded. */
interface Reply {
	participant: Participant;
	answer: AskAnswer;
}

/** Ask a roster about a change and record what it says. */
export async function runCouncil(
	request: CouncilRequest,
	deps: CouncilDeps,
): Promise<CouncilResult> {
	const round = request.round ?? "council";
	const startedAt = deps.now();
	const id = newRunId(round, startedAt, request.seq);

	const replies = await Promise.all(
		request.roster.reviewers.map(
			async (participant): Promise<Reply> => ({
				participant,
				answer: await asked(participant, request.prompt, deps),
			}),
		),
	);

	const warnings: string[] = [];
	const outcomes: ParticipantOutcome[] = [];
	// Sequential and in roster order, which is what makes the
	// numbering deterministic. Recording concurrently would hand out
	// ids in completion order.
	for (const reply of replies) {
		outcomes.push(
			await recordReply(
				reply,
				{ runId: id, witness: request.witness },
				deps,
				warnings,
			),
		);
	}

	const participants: ParticipantIdentity[] = request.roster.reviewers.map(
		(participant) => participantIdentity("reviewer", participant),
	);

	return {
		run: {
			id,
			round,
			startedAt: startedAt.toISOString(),
			participants,
			outcomes,
		},
		warnings,
	};
}

/**
 * Ask one participant, turning a thrown error into a reported one.
 *
 * A runner that rejects and one that answers with a failure are the
 * same event, and a caller downstream should not have to care which
 * shape it arrived in.
 */
async function asked(
	participant: Participant,
	prompt: string,
	deps: CouncilDeps,
): Promise<AskAnswer> {
	try {
		return await deps.ask(participant, prompt);
	} catch (error) {
		return {
			failure: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Harvest one reply, record what it held, and say how it went. */
async function recordReply(
	reply: Reply,
	run: { runId: string; witness?: string },
	deps: CouncilDeps,
	warnings: string[],
): Promise<ParticipantOutcome> {
	const { participant, answer } = reply;
	if ("failure" in answer) {
		return {
			participantId: participant.id,
			findingIds: [],
			failure: answer.failure,
		};
	}

	const harvest = harvestFindings(
		answer.text,
		{ kind: "reviewer", runId: run.runId, reviewerId: participant.id },
		run.witness,
	);
	for (const warning of harvest.warnings) {
		warnings.push(`${participant.id}: ${warning}`);
	}

	const recorded =
		harvest.findings.length === 0 ? [] : await deps.record(harvest.findings);

	return {
		participantId: participant.id,
		findingIds: recorded.map((finding) => finding.id),
		...(answer.usage === undefined ? {} : { usage: answer.usage }),
	};
}
