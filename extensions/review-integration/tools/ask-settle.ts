/**
 * Settling `review_ask` rounds nothing waits on: stopping a started
 * round, collecting one whose session ended, and collecting finished
 * rounds at a session's start or before a judge reads them.
 *
 * Apart from ask.ts because settling asks nobody and spends nothing:
 * it reads what reviewers left on disk and files it, and it changes
 * for reasons of its own (how a stop waits, when a round counts as
 * abandoned) rather than with how a round is asked.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../../../lib/core/internal/file-lock.ts";
import {
	type AskAnswer,
	type AskRun,
	type ChangeRef,
	collectRound,
	createFindingStore,
	createRunStore,
	type OpenRound,
} from "../../../lib/core/review/index.ts";
import {
	RESUME_SUFFIX,
	ReviewerArtifactsStore,
	WRAP_UP_SUFFIX,
} from "../../../lib/subagent/index.ts";
import { count } from "../../../lib/ui/count.ts";
import {
	answerDir,
	findingDir,
	runArtifactDir,
	runDir,
	sessionKey,
} from "../engine.ts";
import { GLYPH } from "../render.ts";
import {
	answerLeftBehind,
	archivedAnswer,
	collectedRun,
	recordReviewerRun,
	whyNotYet,
} from "../reviewer.ts";
import { answerFor, judgeHandOff, keptOnLedger } from "./ask-answer.ts";
import { type Answer, refuse, say } from "./shared.ts";

/** Which round a stop or a collect names, when there is a choice. */
interface RoundNamed {
	readonly run?: string;
}

/**
 * Ask a started round to stop.
 *
 * The only off switch a detached round has. A council is cancelled by
 * the panel, through a signal held by the session that is waiting; a
 * started round has no session waiting and so nothing to press
 * Escape on. Without this the only way to end one is to find seven
 * pids by hand, and an expensive roster asked the wrong question runs
 * to its backstop while somebody watches the bill.
 *
 * Nothing is lost by stopping. Each reviewer's journal is already on
 * disk, the supervisor records the stop the way it records any other,
 * and collect reads what they had.
 */
export async function stopRound(
	change: ChangeRef,
	params: RoundNamed,
): Promise<Answer> {
	const store = createRunStore(runDir());
	const open = (await store.list(change)).filter((run) => run.open === true);
	if (open.length === 0) {
		return say(`No round on ${change.label} is still running.`, { runs: [] });
	}
	const held =
		params.run === undefined
			? open.length === 1
				? open[0]
				: undefined
			: open.find((run) => run.id === params.run);
	if (held === undefined) {
		return refuse(
			params.run === undefined
				? `${count(open.length, "round")} on ${change.label} is still running, so say which one to stop: ${open.map((run) => run.id).join(", ")}.`
				: `No open round "${params.run}" is held against ${change.label}. Open: ${open.map((run) => run.id).join(", ")}.`,
		);
	}

	const artifacts = new ReviewerArtifactsStore(runArtifactDir());
	// Unconditionally, and before anything is decided. The sentinel is
	// what makes stopping race-free: the supervisor polls for it every
	// half second, so one written before a supervisor has finished
	// booting is still honoured. Writing it only when a reviewer looks
	// live makes one predicate decide both halves, and the window
	// between `start` returning and the first lease appearing is
	// exactly when a start-then-stop lands.
	await artifacts.requestRunCancellation(
		held.id,
		`Stopped from a session on ${new Date().toISOString()}.`,
	);

	// Waited out here, then collected, rather than handed back with
	// "collect it once they are gone": on 30 October five of the ten
	// rounds open on the machine were rounds somebody had stopped and
	// nobody collected, each one nagging every session at its start.
	if (!(await goneWithin(artifacts, held, STOP_SETTLE_MS))) {
		return say(
			[
				`Asked every reviewer in ${held.id} to stop.`,
				`They had not all gone after ${STOP_SETTLE_MS / 1000} s. They are killed if they do not stop, and once they are gone the next session start of this one collects the round: what they wrote down before stopping is kept.`,
			].join("\n"),
			{ run: held },
		);
	}

	// Nothing looks like it is running, so the other reading of "stop
	// this round" applies: stop carrying it. That matters because a
	// collect which recovers nothing deliberately leaves the round
	// open, on the grounds that its work may be under another state
	// directory or on another machine. Correct, and it leaves an alarm
	// with no answer: the round sits in every listing forever. This is
	// the answer, and it is a person saying so rather than a sweep
	// deciding on their behalf.
	// Something left behind is collected, so stopping a round never
	// leaves it open: its findings are filed rather than binned.
	if ((await somethingLeftBehind(artifacts, held)) !== undefined) {
		return collectHeld(change, held, artifacts);
	}

	// Marked closed rather than merely un-opened. A round with no
	// outcomes that reads as finished becomes the latest council on the
	// change, and the next judge would consolidate its nothing.
	const closed: AskRun = { ...held, closed: true };
	delete (closed as { open?: true }).open;
	const kept = await keptOnLedger(change, closed);
	return say(
		[
			`Nothing was running in ${held.id} and nobody left anything behind, so it is closed unfinished rather than left open forever.`,
			"If its transcripts turn up under another state directory, the round is gone from this ledger and would have to be read there.",
			...kept,
		].join("\n"),
		{ run: closed },
	);
}

/**
 * Who, if anybody, left work in this round worth collecting.
 *
 * The result file is not the only evidence. A reviewer killed hard
 * never writes one, and its journal is the thing the journal exists
 * for: the findings it had already formed. Closing a round on the
 * strength of a missing result would throw away exactly the work the
 * whole recovery story was built to keep.
 */
async function somethingLeftBehind(
	artifacts: ReviewerArtifactsStore,
	held: AskRun,
): Promise<string | undefined> {
	for (const participant of held.participants) {
		for (const id of [
			participant.id,
			`${participant.id}${WRAP_UP_SUFFIX}`,
			`${participant.id}${RESUME_SUFFIX}`,
		]) {
			const left = await answerLeftBehind(artifacts, held.id, id);
			if (left.kind !== "missing") return id;
			const { journalPath } = artifacts.paths(held.id, id);
			if (await readable(journalPath)) return id;
		}
	}
	return undefined;
}

/** Whether a file is there with something in it. */
async function readable(path: string): Promise<boolean> {
	try {
		return (await stat(path)).size > 0;
	} catch {
		// Not there, which is the answer rather than a failure.
		return false;
	}
}

/**
 * Finish a round whose session ended before it could.
 *
 * Everything the reviewers produced is already on disk, and until now
 * the only thing that could turn it into findings was the session that
 * died. This asks nobody and spends nothing: it reads what is there,
 * files it the way the round would have, and settles the round.
 */
export async function collectOne(
	change: ChangeRef,
	params: RoundNamed,
): Promise<Answer> {
	const store = createRunStore(runDir());
	const everyRound = await store.list(change);
	const unsettled = everyRound.filter((run) => run.open === true);
	if (everyRound.length === 0) {
		// Not "settled on its own": nothing is held here at all, which is
		// what a reference resolved by another provider than the one that
		// ran its rounds looks like.
		return say(
			`No rounds are held against ${change.label} as the ${change.provider} provider names it, so there is nothing to collect. If rounds ran on it, name the change the way the provider that ran them does, from a checkout of its repository.`,
			{ runs: [] },
		);
	}
	if (unsettled.length === 0) {
		return say(
			`Every round on ${change.label} settled on its own, so there is nothing to collect.`,
			{ runs: [] },
		);
	}
	// Named when there is a choice, rather than guessing at the newest.
	// Collecting files findings against the change, and doing that to
	// the wrong round is not undoable.
	const held =
		params.run === undefined
			? unsettled[0]
			: unsettled.find((run) => run.id === params.run);
	if (held === undefined) {
		return refuse(
			`No unsettled round "${params.run}" is held against ${change.label}. Unsettled: ${unsettled.map((run) => run.id).join(", ")}.`,
		);
	}
	if (params.run === undefined && unsettled.length > 1) {
		return refuse(
			`${count(unsettled.length, "round")} on ${change.label} never settled, so say which one to collect: ${unsettled.map((run) => run.id).join(", ")}.`,
		);
	}

	const artifacts = new ReviewerArtifactsStore(runArtifactDir());
	const alive = await whyNotYet(artifacts, held);
	if (alive !== undefined) return refuse(alive);
	return collectHeld(change, held, artifacts);
}

/**
 * Settle one round nothing is running any more, from what its
 * reviewers left on disk. The caller has checked it is finished.
 */
async function collectHeld(
	change: ChangeRef,
	held: AskRun,
	artifacts: ReviewerArtifactsStore,
): Promise<Answer> {
	const answers = new Map<string, AskAnswer>();
	const unreadable: string[] = [];
	for (const participant of held.participants) {
		// No budget. On the live path the same config call configured
		// the run, so stamping it on a stop is history. Here the round
		// ran hours or days ago, possibly under different numbers, and
		// writing today's into the stop would record a limit the run
		// never hit and then refuse the retry that raising it was for.
		const left = await answerLeftBehind(artifacts, held.id, participant.id);
		if (left.kind === "answer") {
			// Nothing watched a started round, so this is the one place
			// that sees what it cost. The run table upserts on the round
			// and reviewer, so a reviewer a dying session already counted
			// is counted once.
			recordReviewerRun(collectedRun(held, participant.id, left.result));
			answers.set(
				participant.id,
				await archivedAnswer(answerDir(), held, participant.id, left.answer),
			);
		}
		if (left.kind === "unreadable") {
			unreadable.push(`${participant.id}: ${left.why}`);
		}
	}

	const findings = createFindingStore(findingDir());
	const store2 = createRunStore(runDir());
	const { run, warnings } = await collectRound(held, answers, {
		record: (raised) => findings.record(change, raised),
		// Each participant's outcome is held as it is filed, so a
		// collect that dies halfway leaves durable progress and the next
		// one does not file the same findings again.
		progressed: (partial) => store2.keep(change, partial),
	});
	const kept = await keptOnLedger(change, run);
	return say(
		[
			`Collected ${run.id}, which opened at ${held.startedAt} and was never settled.`,
			answerFor(run, [
				...warnings,
				...unreadable.map(
					(said) =>
						`${GLYPH.refused} Nothing could be read back for ${said}. Whatever it found is still in its directory under ${runArtifactDir()}.`,
				),
				...kept,
			]),
			...judgeHandOff(run),
		].join("\n"),
		{ run, warnings },
	);
}

/** How long a stop waits for its reviewers to go before collecting. */
const STOP_SETTLE_MS = 15_000;

/** How often a stop looks again while its reviewers go. */
const STOP_POLL_MS = 250;

/** Whether every reviewer of `held` is gone within `withinMs`. */
async function goneWithin(
	artifacts: ReviewerArtifactsStore,
	held: AskRun,
	withinMs: number,
): Promise<boolean> {
	const deadline = Date.now() + withinMs;
	for (;;) {
		if ((await whyNotYet(artifacts, held)) === undefined) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((done) => setTimeout(done, STOP_POLL_MS));
	}
}

/**
 * How long a finished round may sit open before any session's sweep
 * collects it. The session that started it collects its own at once;
 * a day is the stated rule for a round whose session never comes back.
 */
export const ABANDONED_ROUND_MS = 24 * 60 * 60 * 1000;

/**
 * Collect, at a session's start, the open rounds it may: its own, and
 * anybody's left open past {@link ABANDONED_ROUND_MS}, once every
 * reviewer in them has finished and the ledger names the change.
 * Answers the ids collected, and this session's own rounds it left,
 * still running or with no change named, for its model to be told of.
 */
export async function collectSettled(
	rounds: readonly OpenRound[],
	now: number = Date.now(),
): Promise<{ collected: string[]; leftMine: OpenRound[] }> {
	const mine = sessionKey();
	const artifacts = new ReviewerArtifactsStore(runArtifactDir());
	const store = createRunStore(runDir());
	const collected: string[] = [];
	const leftMine: OpenRound[] = [];
	for (const round of rounds) {
		const own = round.startedBy === mine;
		const abandoned = now - Date.parse(round.startedAt) > ABANDONED_ROUND_MS;
		if (!own && !abandoned) continue;
		const change = round.change;
		if (change === undefined) {
			if (own) leftMine.push(round);
			continue;
		}
		// Under the ledger's own lock, read again, so two sessions starting
		// together collect a round once between them.
		const done = await withFileLock(
			join(runArtifactDir(), `${round.id}.collecting`),
			async () => {
				const held = await store.byId(change, round.id);
				if (held?.open !== true) return false;
				if ((await whyNotYet(artifacts, held, undefined, now)) !== undefined) {
					return undefined;
				}
				await collectHeld(change, held, artifacts);
				return true;
			},
		);
		if (done === true) collected.push(round.id);
		if (done === undefined && own) leftMine.push(round);
	}
	return { collected, leftMine };
}

/**
 * Collect every started round on a change whose reviewers have all
 * finished, before a judge reads the latest council.
 *
 * A judge asked about a started round used to be refused with "collect
 * it first", eleven times in a week, and the agent's next call was
 * always the collect. Collecting asks nobody and spends nothing, so the
 * judge does it. A round still running is left alone and named, since
 * judging half a council would consolidate findings not yet made.
 */
export async function collectFinished(
	change: ChangeRef,
	now: number = Date.now(),
): Promise<{ said: string[]; running: string[] }> {
	const store = createRunStore(runDir());
	const artifacts = new ReviewerArtifactsStore(runArtifactDir());
	const said: string[] = [];
	const running: string[] = [];
	for (const held of await store.list(change)) {
		if (held.open !== true) continue;
		const alive = await whyNotYet(artifacts, held, undefined, now);
		if (alive !== undefined) {
			running.push(alive);
			continue;
		}
		const answer = await collectHeld(change, held, artifacts);
		said.push(
			answer.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join(""),
		);
	}
	return { said, running };
}
