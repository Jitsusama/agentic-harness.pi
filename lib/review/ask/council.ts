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
import { type AskProgress, noAskProgress, settleReplies } from "./progress.js";
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
	/**
	 * Run one participant against the prompt.
	 *
	 * `report` is how a long-running ask says what it is doing. It is
	 * optional to call and optional to receive: the library cannot see
	 * a subprocess, so activity only exists if the implementation
	 * volunteers it.
	 */
	ask(
		participant: Participant,
		prompt: string,
		report?: (activity: string) => void,
	): Promise<AskAnswer>;
	/** Put findings on the change, numbering them as they land. */
	record(findings: Omit<Finding, "id">[]): Promise<Finding[]>;
	now(): Date;
	/** Told what is happening while it happens. Optional. */
	progress?: AskProgress;
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
export interface Reply {
	participant: Participant;
	answer: AskAnswer;
}

/**
 * Ask every reviewer at once and hand the answers back in roster
 * order.
 *
 * Shared with the stack round rather than written twice, because this
 * is the part with the rules in it: concurrent asking, a thrown error
 * and a reported one becoming the same thing, and the ordering that
 * makes finding numbers stable. A stack round differs in what a reply
 * *means*, not in how a roster is asked, and if the ordering rule ever
 * changes both rounds have to change with it.
 */
export async function askRoster(
	roster: Roster,
	prompt: string,
	deps: Pick<CouncilDeps, "ask" | "progress">,
): Promise<Reply[]> {
	const progress = deps.progress ?? noAskProgress;
	progress.start(roster.reviewers);
	return await Promise.all(
		roster.reviewers.map(async (participant): Promise<Reply> => {
			progress.started(participant.id);
			const answer = await asked(participant, prompt, deps, (activity) =>
				progress.activity(participant.id, activity),
			);
			// A failure the runner hands back and one it throws are the
			// same event to somebody watching a board.
			if ("failure" in answer) progress.failed(participant.id, answer.failure);
			else progress.answered(participant.id);
			return { participant, answer };
		}),
	);
}

/**
 * Ask one participant, reported the same way a roster is.
 *
 * A round with a single participant is still a round somebody is waiting
 * on, and the wait is no shorter for being one subagent: a judge
 * consolidating sixty findings takes as long as the council that raised
 * them. Reporting was left to each round to remember, and the judge did
 * not, so it ran to completion showing nothing at all.
 *
 * Beside `askRoster` rather than inside it, because a fan-out of one is
 * not what this is: there is no ordering rule to share and no concurrency
 * to arrange. What the two have in common is the beats they report, and
 * this is the place that says what those are for one participant.
 */
export async function askOne(
	participant: Participant,
	prompt: string,
	deps: Pick<CouncilDeps, "ask" | "progress">,
): Promise<AskAnswer> {
	const progress = deps.progress ?? noAskProgress;
	progress.start([participant]);
	progress.started(participant.id);
	const answer = await asked(participant, prompt, deps, (activity) =>
		progress.activity(participant.id, activity),
	);
	// A failure the runner hands back and one it throws are the same event
	// to somebody watching a board.
	if ("failure" in answer) progress.failed(participant.id, answer.failure);
	else progress.answered(participant.id);
	return answer;
}

/** Ask a roster about a change and record what it says. */
export async function runCouncil(
	request: CouncilRequest,
	deps: CouncilDeps,
): Promise<CouncilResult> {
	const round = request.round ?? "council";
	const startedAt = deps.now();
	const id = newRunId(round, startedAt, request.seq);

	const replies = await askRoster(request.roster, request.prompt, deps);

	const warnings: string[] = [];
	const outcomes = await settleReplies(
		replies,
		(reply) =>
			recordReply(
				reply,
				{ runId: id, witness: request.witness },
				deps,
				warnings,
			),
		(outcome) => ({
			participantId: outcome.participantId,
			findings: outcome.findingIds.length,
		}),
		deps.progress,
	);

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
	deps: Pick<CouncilDeps, "ask">,
	report?: (activity: string) => void,
): Promise<AskAnswer> {
	try {
		return await deps.ask(participant, prompt, report);
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
