/**
 * Asking a roster about a whole stack at once.
 *
 * The fan-out is the council's, reused rather than rewritten: the
 * rules worth getting right, that participants are asked concurrently,
 * that a thrown error and a reported one are the same event, and that
 * findings are numbered in roster order, are the same rules here and
 * would have to change together. What differs is what a reply means. A
 * council reply is findings about one change; a stack reply is
 * findings about a stack, each naming the changes it is about.
 *
 * Which is why `record` takes a ref. A stack round produces findings
 * for several changes at once, and the store needs to know which
 * change each belongs to. A spanning finding is filed once, at its
 * earliest change, because filing it on every change it touches makes
 * a reader answer one observation three times.
 */

import type { Finding } from "../finding.js";
import {
	type AskAnswer,
	askRoster,
	type CouncilResult,
	type Reply,
} from "./council.js";
import {
	type Participant,
	type ParticipantIdentity,
	participantIdentity,
} from "./identity.js";
import { type AskProgress, settleReplies } from "./progress.js";
import type { Roster } from "./roster.js";
import { newRunId, type ParticipantOutcome } from "./run.js";
import { harvestStackFindings, saidAt } from "./span.js";

/** The impure things a stack round needs. */
export interface StackCouncilDeps {
	/**
	 * Run one participant against the prompt.
	 *
	 * `report` is how a long-running ask says what it is doing, and a
	 * stack round is the longest there is: it reads every change.
	 */
	ask(
		participant: Participant,
		prompt: string,
		report?: (activity: string) => void,
	): Promise<AskAnswer>;
	/** File findings against one change in the stack. */
	record(ref: string, findings: Omit<Finding, "id">[]): Promise<Finding[]>;
	now(): Date;
	/** Told what is happening while it happens. Optional. */
	progress?: AskProgress;
}

/** What to ask, of whom, about which changes. */
export interface StackCouncilRequest {
	roster: Roster;
	prompt: string;
	/** Distinguishes two rounds started in the same millisecond. */
	seq: number;
	/** Every change in the stack, roots before children. */
	stackRefs: string[];
	/**
	 * The commit one change's anchors are formed against.
	 *
	 * Per change, because each has its own diff: checking a finding on
	 * the tip against the base's diff would degrade a good anchor for
	 * nothing.
	 */
	witnessFor?: (ref: string) => string | undefined;
}

/** Ask a roster about a stack and file what it says. */
export async function runStackCouncil(
	request: StackCouncilRequest,
	deps: StackCouncilDeps,
): Promise<CouncilResult> {
	const startedAt = deps.now();
	const id = newRunId("stack", startedAt, request.seq);

	const replies = await askRoster(request.roster, request.prompt, deps);

	const warnings: string[] = [];
	const outcomes = await settleReplies(
		replies,
		(reply) => fileReply(reply, id, request, deps, warnings),
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
			round: "stack",
			startedAt: startedAt.toISOString(),
			participants,
			outcomes,
		},
		warnings,
	};
}

/** Read one reply, file it change by change, and say how it went. */
async function fileReply(
	reply: Reply,
	runId: string,
	request: StackCouncilRequest,
	deps: StackCouncilDeps,
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

	const harvest = harvestStackFindings(
		answer.text,
		{ kind: "reviewer", runId, reviewerId: participant.id },
		request.stackRefs,
		request.witnessFor,
	);
	for (const warning of harvest.warnings) {
		warnings.push(`${participant.id}: ${warning}`);
	}

	// Grouped by where each finding is said, and filed in stack order
	// so ids run the way a reader walks the stack.
	const byRef = new Map<string, Omit<Finding, "id">[]>();
	for (const { span, finding } of harvest.findings) {
		const ref = saidAt(span, request.stackRefs);
		const held = byRef.get(ref);
		if (held === undefined) byRef.set(ref, [finding]);
		else held.push(finding);
	}

	const findingIds: number[] = [];
	for (const ref of request.stackRefs) {
		const held = byRef.get(ref);
		if (held === undefined) continue;
		const recorded = await deps.record(ref, held);
		findingIds.push(...recorded.map((finding) => finding.id));
	}

	return {
		participantId: participant.id,
		findingIds,
		...(answer.usage === undefined ? {} : { usage: answer.usage }),
	};
}
