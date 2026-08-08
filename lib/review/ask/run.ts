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
	 * Something true of the session rather than of this participant.
	 *
	 * Stated by whatever dispatched the round, since only that side
	 * can tell a broken session from a broken reviewer.
	 */
	advisory?: string;
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
	 * Given up on by a person, rather than finished.
	 *
	 * There are three states here, not two, and the third cannot be
	 * spelled as the absence of the second. A round closed because
	 * nothing was running and nothing was left behind is not a
	 * council that reported: it has no outcomes and no findings, so
	 * merely clearing `open` would make it the most recent finished
	 * council on the change, and `latest` would hand it to the next
	 * judge, critique and retry. Each would consolidate nothing and
	 * report that the council found nothing, while the real council
	 * sat one entry behind, unreachable.
	 *
	 * Marked by something present rather than inferred from something
	 * missing, for the same reason `open` is.
	 */
	closed?: true;
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
	/**
	 * Said when the tree the reviewers read was not that commit.
	 *
	 * Every round records a witness, and a round that fell back to
	 * the caller's checkout records one too, so without this the
	 * ledger claims a fidelity the round did not have. The caveat
	 * itself was only ever handed to the session that started the
	 * round, which leaves a round collected later, whose reader has
	 * nothing but this file, told nothing at all.
	 *
	 * It happens. Two councils fell back because a worktree of that
	 * name already existed, and between them they returned fifty-nine
	 * findings formed against whatever the checkout happened to be.
	 */
	unpinned?: string;
}

/** How a run went, in counts. */
export interface RunSummary {
	asked: number;
	answered: number;
	failed: number;
	/**
	 * Asked, and not yet reported either way.
	 *
	 * Only ever non-zero for a round still open. A round that has
	 * settled has heard from everybody it is going to hear from, so a
	 * participant with no outcome there has dropped.
	 */
	pending: number;
	findings: number;
	/**
	 * What the round burned, across everybody who reported it.
	 *
	 * Absent rather than zero when nobody reported, because a round of
	 * participants that said nothing about usage is not a free round,
	 * and a zero here would say it was.
	 *
	 * A failed participant counts. It was billed for whatever it
	 * burned before it died, and leaving those out would make the
	 * expensive failures look like the cheap ones, which is backwards:
	 * a reviewer that ran fifteen minutes and produced nothing is the
	 * most expensive kind there is.
	 */
	tokens?: number;
	/** What it came to in money, on the same terms as `tokens`. */
	cost?: number;
	/**
	 * Whether anybody who was asked is missing from those totals.
	 *
	 * A round where six of seven reported is not a round that cost the
	 * sum of six, and printing one as the other is the same lie as
	 * printing zero for a round nobody priced. The participants most
	 * likely to be missing are the ones that died, which are the dear
	 * ones, so the error runs the wrong way.
	 */
	partlyPriced?: boolean;
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
 * What is wrong with the session rather than with the reviewers.
 *
 * Measured. Pi upgraded mid-session and deleted the versioned install
 * directory the running session pins its children to, so every
 * reviewer died on dispatch. The runner diagnosed it correctly and
 * put the same sentence on all seven, and the round printed it seven
 * times as though seven separate things had gone wrong.
 *
 * The repetition is not the cost. Seven failures beside a retry hint
 * read as seven flaky reviewers, and retrying is the one thing that
 * cannot work: it fails identically until the session restarts.
 *
 * Read off the outcome rather than sniffed out of the message. This
 * matched a prefix first, which made one library string-match another
 * library's prose, and both are free to reword: the diagnosis is a
 * fact the dispatching side knows, so it is carried as one.
 *
 * One participant is enough. A stale install kills every reviewer it
 * reaches, and a round where one dispatch raced the deletion is
 * exactly as unrecoverable by retry as one where all seven did.
 */
export function staleRuntimeAdvisory(run: AskRun): string | undefined {
	return run.outcomes.find((one) => one.advisory !== undefined)?.advisory;
}

/**
 * One line for each participant that failed, without saying the same
 * paragraph twice.
 *
 * The roll call has to survive an advisory: a reader needs to see who
 * was asked and that none of them answered, or the round looks like it
 * never ran. What it does not need is the advisory repeated under
 * every name, which is what hoisting a sentence already on every
 * outcome would otherwise produce, one copy longer than before.
 *
 * What was hoisted is told rather than worked out again. Deciding it
 * twice means the two can disagree, and the way they disagree is the
 * worst of both: a caller that suppressed the advisory gets a roll
 * call of reviewers pointing at a line that is not there.
 */
export function failureLines(run: AskRun, hoisted?: string): string[] {
	const lines: string[] = [];
	for (const outcome of run.outcomes) {
		if (outcome.failure === undefined) continue;
		lines.push(
			outcome.failure === hoisted
				? `${outcome.participantId}: as above.`
				: `${outcome.participantId}: ${outcome.failure}`,
		);
	}
	return lines;
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
 *
 * Unless the round is still open, where the same silence means the
 * opposite. Nobody has asked those reviewers for anything yet: a
 * started round that has recorded nothing summarised as seven failed
 * out of seven, and every sentence built on that read as an
 * accusation against reviewers who were at that moment working.
 */
export function runSummary(run: AskRun): RunSummary {
	let answered = 0;
	let reported = 0;
	let findings = 0;
	let tokens: number | undefined;
	let cost: number | undefined;
	for (const participant of run.participants) {
		const outcome = run.outcomes.find(
			(o) => o.participantId === participant.id,
		);
		if (outcome === undefined) continue;
		// Before the failure check, because a reviewer that died still
		// spent what it spent.
		if (outcome.usage?.tokens !== undefined) {
			tokens = (tokens ?? 0) + outcome.usage.tokens;
		}
		if (outcome.usage?.cost !== undefined) {
			cost = (cost ?? 0) + outcome.usage.cost;
		}
		if (outcome.failure !== undefined) {
			reported += 1;
			continue;
		}
		answered += 1;
		findings += outcome.findingIds.length;
	}
	// A failure somebody recorded is a failure whatever state the round
	// is in. Only silence changes meaning: on a settled round it is a
	// participant that dropped, and on an open one it is a participant
	// nobody has asked about yet.
	const silent = run.participants.length - answered - reported;
	const priced = run.outcomes.filter(
		(outcome) => outcome.usage !== undefined,
	).length;
	return {
		asked: run.participants.length,
		answered,
		failed: reported + (run.open === true ? 0 : silent),
		pending: run.open === true ? silent : 0,
		findings,
		...(tokens === undefined ? {} : { tokens }),
		...(cost === undefined ? {} : { cost }),
		...(priced > 0 && priced < run.participants.length
			? { partlyPriced: true }
			: {}),
	};
}

/**
 * A retried outcome, carrying what the attempt it replaces cost.
 *
 * The findings are replaced, because the new attempt supersedes the
 * old one and the round should not show both. The money is not: it
 * was spent, and the reviewer being asked twice is precisely why the
 * round cost what it did. Replacing the usage as well made the total
 * fall after money had gone out, so the rounds with retries in them,
 * which are the expensive ones, were the ones that under-reported.
 */
function billedWith(
	outcome: ParticipantOutcome,
	replaced: ParticipantOutcome,
): ParticipantOutcome {
	const before = replaced.usage;
	if (before === undefined) return outcome;
	const tokens = sum(outcome.usage?.tokens, before.tokens);
	const cost = sum(outcome.usage?.cost, before.cost);
	if (tokens === undefined && cost === undefined) return outcome;
	return {
		...outcome,
		usage: {
			...(tokens === undefined ? {} : { tokens }),
			...(cost === undefined ? {} : { cost }),
		},
	};
}

/** Two numbers added, where absent still means not told. */
function sum(
	one: number | undefined,
	two: number | undefined,
): number | undefined {
	if (one === undefined) return two;
	return two === undefined ? one : one + two;
}

/** What a round was told about the tree it would read. */
export interface TreeRead {
	/** Commit the findings' anchors are formed against. */
	witness?: string;
	/** Said when the tree the reviewers read was not that commit. */
	unpinned?: string;
}

/**
 * What a round read, in the shape a run records it.
 *
 * One helper rather than a conditional spread per builder, because
 * these two are one fact. Recording the commit without the caveat is
 * the failure this exists to stop: the run then claims the reviewers
 * read the change when they read whatever the caller had checked out.
 * Six sites spread the commit by hand, and it took until the ledger
 * was counted to notice that half of them recorded nothing at all.
 */
export function whatItRead(read: TreeRead): TreeRead {
	return {
		...(read.witness === undefined ? {} : { witness: read.witness }),
		...(read.unpinned === undefined ? {} : { unpinned: read.unpinned }),
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
			: run.outcomes.map((held, index) =>
					index === at ? billedWith(outcome, held) : held,
				);

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
