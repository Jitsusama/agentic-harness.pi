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

import { count } from "../../ui/count.js";
import type { Finding } from "../finding.js";
import { alsoRecorded, type Harvest, harvestFindings } from "./harvest.js";
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

/**
 * Which limit ended a reviewer before it had finished.
 *
 * A limit is not a failure. The reviewer was working, and something
 * on our side decided it had worked long enough, so the two are
 * reported apart: a failure is the run never happening, and a stop
 * is the run being taken away mid-sentence.
 */
export type AskLimit =
	| "wall-clock"
	| "idle"
	| "output"
	/**
	 * Stopped inside its own budget, deliberately, so what it had
	 * could be asked for while there was still time to answer.
	 *
	 * The only limit here that is not something running out. The
	 * others describe a reviewer that was taken away; this one
	 * describes one that was asked.
	 */
	| "soft-deadline"
	| "cancelled"
	| "parent-exit";

/** A reviewer stopped before it finished, and what stopped it. */
export interface AskStop {
	limit: AskLimit;
	/** What happened, in the runner's own words. */
	detail: string;
	/**
	 * The budget it ran out of, where the limit is a clock.
	 *
	 * Recorded so a later retry can tell whether anything has moved.
	 * Without the number, the only way to find out whether asking
	 * again would hit the same wall is to ask again and watch.
	 */
	budgetMs?: number;
}

/** What came back from asking one participant. */
export type AskAnswer =
	| {
			text: string;
			usage?: AskUsage;
			stopped?: AskStop;
			/**
			 * What this participant had said before it was stopped, when
			 * the answer above is one it gave afterwards.
			 *
			 * Two answers rather than one joined, because only a reader
			 * that can count findings knows which is worth keeping, and
			 * joining them makes both unreadable.
			 */
			earlierText?: string;
			/**
			 * Findings this participant wrote down as it found them,
			 * rather than saving them for its answer.
			 *
			 * On the wire, unread, because reading one is this module's
			 * job and the thing that collected them cannot make a finding
			 * without knowing whose round it is.
			 */
			recorded?: unknown[];
			/**
			 * What went wrong that this answer cannot show for itself.
			 *
			 * A run can produce findings and still have gone badly: the
			 * process died after recording them, or its journal came
			 * back capped or unreadable. Neither is a failure, since
			 * there is an answer to read, and neither is visible in the
			 * answer. Without somewhere to put them the diagnosis is
			 * lost at this seam and a dead reviewer reads as a clean
			 * pass.
			 */
			notes?: string[];
			/** Where the answer was kept, when the runner kept it. */
			answerPath?: string;
	  }
	| { failure: string };

/**
 * What a round can tell a runner about itself.
 *
 * The runner is the thing that leaves artifacts behind, and it cannot
 * work out which round it belongs to on its own. A transcript that
 * cannot be traced back to the round that paid for it answers none of
 * the questions a transcript is kept for.
 */
export interface AskContext {
	/** The round this ask belongs to, as the ledger names it. */
	runId: string;
	/**
	 * How a long-running ask says what it is doing. Optional to call
	 * and optional to receive: the library cannot see a subprocess, so
	 * activity only exists if the implementation volunteers it.
	 */
	report?(activity: string): void;
}

/**
 * Run one participant against the prompt, for a named round.
 *
 * Named once and shared by every round's deps. Each used to restate
 * the signature, which is how two of them still had a bare report
 * callback after the context arrived.
 */
export type Ask = (
	participant: Participant,
	prompt: string,
	context: AskContext,
) => Promise<AskAnswer>;

/** The impure things asking needs. */
export interface CouncilDeps {
	ask: Ask;
	/** Put findings on the change, numbering them as they land. */
	record(findings: Omit<Finding, "id">[]): Promise<Finding[]>;
	now(): Date;
	/**
	 * The round exists and nobody has been asked yet.
	 *
	 * Called once, before the first reviewer is dispatched, so a
	 * caller that keeps a ledger can write the round down before it
	 * becomes expensive rather than after it has already paid.
	 * Optional, because a round is worth more than the bookkeeping
	 * around it and most callers keep no ledger at all.
	 */
	opened?(run: AskRun): Promise<void>;
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
	runId: string,
	deps: Pick<CouncilDeps, "ask" | "progress">,
): Promise<Reply[]> {
	const progress = deps.progress ?? noAskProgress;
	progress.start(roster.reviewers);
	return await Promise.all(
		roster.reviewers.map(async (participant): Promise<Reply> => {
			progress.started(participant.id);
			const answer = await asked(participant, prompt, deps, {
				runId,
				report: (activity) => progress.activity(participant.id, activity),
			});
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
	runId: string,
	deps: Pick<CouncilDeps, "ask" | "progress">,
): Promise<AskAnswer> {
	const progress = deps.progress ?? noAskProgress;
	progress.start([participant]);
	progress.started(participant.id);
	const answer = await asked(participant, prompt, deps, {
		runId,
		report: (activity) => progress.activity(participant.id, activity),
	});
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
	const participants: ParticipantIdentity[] = request.roster.reviewers.map(
		(participant) => participantIdentity("reviewer", participant),
	);

	// Written down before anything is asked, because everything after
	// this line costs money and takes minutes, and until now the round
	// was recorded only once it was over. A session that died halfway
	// through left seven reviewer directories on disk and nothing
	// saying which change they belonged to or that they were ever a
	// round.
	await deps.opened?.({
		id,
		round,
		startedAt: startedAt.toISOString(),
		participants,
		outcomes: [],
	});

	const replies = await askRoster(request.roster, request.prompt, id, deps);

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

	return {
		run: {
			id,
			round,
			startedAt: startedAt.toISOString(),
			participants,
			outcomes,
			// Read once, not twice. Asking the clock again here would
			// make the settled time drift from the outcomes it settles.
			settledAt: deps.now().toISOString(),
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
	context: AskContext,
): Promise<AskAnswer> {
	try {
		return await deps.ask(participant, prompt, context);
	} catch (error) {
		return {
			failure: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * What to say about a reviewer we stopped.
 *
 * It names what was kept as well as what ended it, because those are
 * two different decisions for the reader: whether to trust the pass,
 * and whether to give it more room next time.
 */
/** Whichever reading of a participant's words found more. */
function richer(said: Harvest, earlier: Harvest | undefined): Harvest {
	if (earlier === undefined) return said;
	return earlier.findings.length > said.findings.length ? earlier : said;
}

/**
 * What to say about a participant that did not get to finish.
 *
 * Shared with the stack round, which is the round most likely to be
 * stopped and was saying nothing about it at all: it pushed the
 * harvest's own warnings through, so a reviewer we interrupted was
 * reported as having written a malformed answer.
 */
export function stopWarning(
	stop: AskStop,
	kept: number,
	cutOff: boolean,
): string {
	const held =
		kept === 0
			? "Nothing had been read from it yet"
			: `${count(kept, "finding")} had been read from it first`;
	// A soft deadline is the round working as intended, so it does not
	// get the sentence written for a reviewer that was cut off. Saying
	// "stopped before it finished" about a reviewer we deliberately
	// asked early would report our own design as an incident, and a
	// reader who saw that on seven participants would go looking for
	// the fault.
	//
	// It still gets the cut-off clause. Being asked early does not
	// stop an answer being truncated on the way out, and that clause
	// is the only thing that says how much is missing. Returning
	// before it threw the sentence away in the case it was written
	// for.
	if (stop.limit === "soft-deadline") {
		return `asked to wrap up early so it had time to answer: ${stop.detail} ${held}, so treat this pass as partial.${cutOff ? CUT_OFF : ""}`;
	}
	// Said here rather than left in the harvest's own warnings, which
	// this branch replaces. Those describe the shape of the text and
	// would blame the reviewer for our deadline; this one is about our
	// deadline, and dropping it was hiding the fact in the exact case
	// it was written for.
	const cut = cutOff ? CUT_OFF : "";
	return `stopped before it finished (${stop.limit}): ${stop.detail} ${held}, so treat this pass as partial.${cut}`;
}

/** Said whenever an answer stopped mid-entry, however it stopped. */
const CUT_OFF =
	" Its answer was cut off mid-entry, so what it was writing when it stopped is gone and there is no telling how much more there would have been.";

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

	const origin = {
		kind: "reviewer" as const,
		runId: run.runId,
		reviewerId: participant.id,
	};
	// A stopped reviewer can have said something twice: once as the
	// fragment it was cut off in, and once when asked afterwards for
	// what it had. Read both and keep whichever carried more, since the
	// wrap-up is asked for only what the reviewer was sure of and may
	// honestly be the shorter of the two. Ties go to the later answer,
	// which is the considered one.
	const harvest = alsoRecorded(
		richer(
			harvestFindings(answer.text, origin, run.witness),
			answer.earlierText === undefined
				? undefined
				: harvestFindings(answer.earlierText, origin, run.witness),
		),
		answer.recorded,
		origin,
		run.witness,
	);
	// A stopped reviewer answers for its own harvest warnings. Those
	// warnings describe the shape of the text, and the text is a
	// sentence we interrupted, so passing them on blames the reviewer
	// for our deadline and tells the reader to fix the wrong thing.
	//
	// A warning about something it recorded is not that. That is a whole
	// line the reviewer wrote deliberately, minutes before the stop, and
	// it failed the contract on its own merits. Dropping it would be the
	// silent drop this module opens by refusing to make: the reader
	// would take the missing finding for the reviewer having nothing
	// more to say.
	const said = [
		...(answer.stopped === undefined
			? harvest.warnings
			: [
					stopWarning(
						answer.stopped,
						harvest.findings.length,
						harvest.truncated === true,
					),
					...(harvest.recordedWarnings ?? []),
				]),
		// Whatever went wrong that the answer cannot show for itself: a
		// process that died after recording something, a journal that
		// came back short. Outside the branch above, because a stop
		// explains neither of them.
		...(answer.notes ?? []),
	];
	for (const warning of said) {
		warnings.push(`${participant.id}: ${warning}`);
	}

	const recorded =
		harvest.findings.length === 0 ? [] : await deps.record(harvest.findings);

	return {
		participantId: participant.id,
		findingIds: recorded.map((finding) => finding.id),
		...(answer.stopped === undefined ? {} : { stopped: answer.stopped }),
		...(answer.answerPath === undefined
			? {}
			: { answerPath: answer.answerPath }),
		...(answer.usage === undefined ? {} : { usage: answer.usage }),
	};
}
