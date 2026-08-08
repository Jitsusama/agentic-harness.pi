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
	type Ask,
	askRoster,
	type CouncilResult,
	type Reply,
	stopWarning,
} from "./council.js";
import { type ParticipantIdentity, participantIdentity } from "./identity.js";
import { type AskProgress, settleReplies } from "./progress.js";
import type { Roster } from "./roster.js";
import { newRunId, type ParticipantOutcome, whatItRead } from "./run.js";
import { alsoRecordedInStack, harvestStackFindings, saidAt } from "./span.js";

/** The impure things a stack round needs. */
export interface StackCouncilDeps {
	/**
	 * Run one participant against the prompt.
	 *
	 * Reporting matters most here: a stack round is the longest there
	 * is, because it reads every change.
	 */
	ask: Ask;
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
	/** Said when the tree the reviewers read was not the stack's tip. */
	unpinned?: string;
}

/** Ask a roster about a stack and file what it says. */
export async function runStackCouncil(
	request: StackCouncilRequest,
	deps: StackCouncilDeps,
): Promise<CouncilResult> {
	const startedAt = deps.now();
	const id = newRunId("stack", startedAt, request.seq);

	const replies = await askRoster(request.roster, request.prompt, id, deps);

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
			// The witness cannot be one commit here, which is why this
			// round carries one per change. The caveat can: a stack is
			// read in a single tree like everything else, so a fallback
			// is a fact about the whole round. The exemption was written
			// about the witness and does not reach this.
			...whatItRead({
				...(request.unpinned === undefined
					? {}
					: { unpinned: request.unpinned }),
			}),
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

	const origin = {
		kind: "reviewer" as const,
		runId,
		reviewerId: participant.id,
	};
	// The same rule as everywhere else, in this round's shape: an
	// anchor may claim a commit only if the reviewer read it. The
	// witnesses here are per change, and a fallback tree misses all of
	// them at once, so the whole lookup goes rather than each answer.
	const formedAt =
		request.unpinned === undefined ? request.witnessFor : undefined;
	const harvest = alsoRecordedInStack(
		harvestStackFindings(answer.text, origin, request.stackRefs, formedAt),
		answer.recorded,
		origin,
		request.stackRefs,
		formedAt,
	);
	// The same rule the single-change round follows, and this round
	// needs it most: it holds every change at once, so it is the one
	// most likely to be interrupted, and it was passing the harvest's
	// own complaints straight through. A reviewer we stopped was being
	// reported as one that wrote a malformed answer.
	const said = [
		...(answer.stopped === undefined
			? harvest.warnings
			: [
					stopWarning(
						answer.stopped,
						harvest.findings.length,
						answer.text.trim() !== "" && harvest.findings.length === 0,
					),
					...(harvest.recordedWarnings ?? []),
				]),
		...(answer.notes ?? []),
	];
	for (const warning of said) {
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
		// The round most likely to be stopped, since it is the one asked
		// to hold every change at once, was the one throwing the stop
		// away.
		...(answer.stopped === undefined ? {} : { stopped: answer.stopped }),
		...(answer.answerPath === undefined
			? {}
			: { answerPath: answer.answerPath }),
		...(answer.usage === undefined ? {} : { usage: answer.usage }),
	};
}
