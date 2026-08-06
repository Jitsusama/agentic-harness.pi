/**
 * What was asked of whom, and what came back.
 *
 * A run is a record rather than a working state: it says who was
 * asked, in which pass, and what each of them came back with. A
 * finding points at its run by id, so a run that got edited under
 * one would change what an already-recorded finding means. Nothing
 * here mutates; substituting an outcome returns a new run.
 *
 * The counts are kept as a function rather than fields, because a
 * stored count and a stored list of outcomes are two things that
 * can disagree, and only one of them is the evidence.
 */

import { count } from "../../ui/count.js";
import type { AskStop } from "./council.js";
import type { ParticipantIdentity } from "./identity.js";

/** Which pass of a review this was. */
export type AskRound =
	| "council"
	| "judge"
	| "critique"
	| "audit"
	/** A council that saw the whole stack rather than one change. */
	| "stack";

/** What one participant's run cost, where the runner said. */
export interface AskUsage {
	tokens?: number;
	cost?: number;
}

/** What one participant came back with. */
export interface ParticipantOutcome {
	participantId: string;
	/**
	 * Findings this participant raised, by the id the store gave
	 * them. Held as ids rather than findings so the run does not
	 * become a second copy of them that can fall out of step.
	 */
	findingIds: number[];
	/** Why nothing came back, when nothing did. */
	failure?: string;
	/**
	 * Which limit took this reviewer away, when one did.
	 *
	 * Recorded even when findings came back, because a stopped
	 * reviewer that raised nine findings had a tenth in hand, and a
	 * reader deciding whether the pass was complete needs to know the
	 * difference between nine and nine-so-far.
	 */
	stopped?: AskStop;
	/**
	 * Where this participant's answer was kept, verbatim.
	 *
	 * Recorded rather than derived from the ids, because a path that
	 * no longer resolves is honest history: it says an answer was kept
	 * here and has since been reclaimed, where a derived path would
	 * claim one that may never have existed.
	 */
	answerPath?: string;
	usage?: AskUsage;
}

/** One pass of asking, and its result. */
export interface AskRun {
	id: string;
	round: AskRound;
	startedAt: string;
	/** Who was asked, in the order the roster named them. */
	participants: ParticipantIdentity[];
	/** What came back. May be shorter than the roster mid-run. */
	outcomes: ParticipantOutcome[];
	/**
	 * This round was written down before it asked anybody, and has
	 * not been settled since.
	 *
	 * Present only while that is true, rather than inferred from a
	 * missing settled time, because absence is the state everything
	 * else already has. Every round recorded before this existed,
	 * and every judge, critique, audit and stack round, carries no
	 * such field and never will, so an alarm keyed on absence would
	 * have declared the entire review history of every change
	 * abandoned the first time anybody asked.
	 *
	 * One producer, one meaning: a council that opened and whose
	 * session did not live to close it. Its reviewers' answers may
	 * still be on disk under this id, and this is the only thing
	 * that says to go looking.
	 */
	open?: true;
	/**
	 * What the reviewers were reading, when the round pinned one.
	 *
	 * Written down because an interrupted round is collected from
	 * disk afterwards, and a finding harvested then has to anchor
	 * exactly as it would have live. Everything else a collect needs
	 * is in the reviewer's own answer; this is not, so a round that
	 * did not record it cannot be collected faithfully.
	 */
	witness?: string;
}

/** How a run went, in counts. */
export interface RunSummary {
	asked: number;
	answered: number;
	failed: number;
	findings: number;
}

/** How many digits a sequence is padded to, so ids sort as text. */
const SEQ_WIDTH = 6;

/**
 * Name a run.
 *
 * The round leads, so a bare id says what pass it was without
 * anything having to look it up. The timestamp sorts. The sequence
 * is part of the name rather than a tiebreak applied later, because
 * two runs inside one millisecond would otherwise collide and make
 * one run's findings unreachable, and it is zero-padded so it keeps
 * sorting as text rather than putting 10 before 9.
 */
export function newRunId(round: AskRound, at: Date, seq: number): string {
	const stamp = at.toISOString().replace(/[-:.]/g, "").replace("Z", "");
	return `${round}-${stamp}-${String(seq).padStart(SEQ_WIDTH, "0")}`;
}

/**
 * What became of each participant a limit took away.
 *
 * The round already records that a reviewer was stopped and where its
 * answer was kept, and recorded both without ever printing them, which
 * is most of the way to losing the answer regardless: nobody opens a
 * ledger they have no reason to open. One line each, naming who, what
 * stopped them and where to read what they said.
 */
export function stoppedNotes(run: AskRun): string[] {
	const notes: string[] = [];
	for (const outcome of run.outcomes) {
		const stopped = outcome.stopped;
		if (stopped === undefined) continue;
		const kept =
			outcome.answerPath === undefined
				? "nothing of its answer was kept"
				: `its answer is at ${outcome.answerPath}`;
		// A soft deadline is the round asking, not the round failing,
		// and the ledger has to say so too. Reframing it in one surface
		// and calling it a stop in the next just moves the alarm.
		const how =
			stopped.limit === "soft-deadline"
				? "asked to wrap up early"
				: `stopped (${stopped.limit})`;
		notes.push(
			`${outcome.participantId} ${how}, ${count(
				outcome.findingIds.length,
				"finding",
			)} read, ${kept}`,
		);
	}
	return notes;
}

/**
 * How a run went.
 *
 * Someone asked with no outcome at all counts as failed rather than
 * as pending, since a run being reported on has finished and a
 * participant that never reported is one that dropped. Answering
 * nothing is an answer: a reviewer that read the change and had no
 * complaint is not a failure, and counting it as one would make a
 * clean review look broken.
 */
export function runSummary(run: AskRun): RunSummary {
	let answered = 0;
	let findings = 0;
	for (const participant of run.participants) {
		const outcome = run.outcomes.find(
			(o) => o.participantId === participant.id,
		);
		if (outcome === undefined || outcome.failure !== undefined) continue;
		answered += 1;
		findings += outcome.findingIds.length;
	}
	return {
		asked: run.participants.length,
		answered,
		failed: run.participants.length - answered,
		findings,
	};
}

/** The identity a run asked under this id, if it asked one. */
export function askedOf(
	run: AskRun,
	participantId: string,
): ParticipantIdentity | undefined {
	return run.participants.find((p) => p.id === participantId);
}

/**
 * Replace one participant's outcome, returning a new run.
 *
 * This is what a retry does. The outcome keeps its position, since
 * a retry that moved a reviewer to the end would reorder every
 * report of the run for no reason a reader could see, and a
 * participant who had no outcome yet gets one appended.
 *
 * Substituting for somebody outside the roster throws rather than
 * refusing softly: it would make the run claim it asked somebody it
 * never did, and no caller has a sensible way to carry on from
 * that.
 */
export function substituteOutcome(
	run: AskRun,
	outcome: ParticipantOutcome,
): AskRun {
	if (askedOf(run, outcome.participantId) === undefined) {
		throw new Error(
			`This run never asked "${outcome.participantId}", so there is no outcome of theirs to replace. It asked ${run.participants.map((p) => p.id).join(", ")}.`,
		);
	}

	const at = run.outcomes.findIndex(
		(o) => o.participantId === outcome.participantId,
	);
	const outcomes =
		at === -1
			? [...run.outcomes, outcome]
			: run.outcomes.map((held, index) => (index === at ? outcome : held));

	// Filling the last gap in an interrupted round settles it.
	//
	// Without this the flag is one-way and the recovery it points at
	// dead-ends: a session dies holding a council, every participant is
	// asked again, and the completed round still reports itself as
	// never settled forever. An alarm nobody can answer stops being
	// read, which costs the one case it was raised for.
	const waiting = run.participants.some(
		(asked) => !outcomes.some((held) => held.participantId === asked.id),
	);
	const { open: _wasOpen, ...rest } = run;
	return waiting ? { ...run, outcomes } : { ...rest, outcomes };
}
