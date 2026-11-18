/**
 * The council rounds of `review_ask`: asking every reviewer on the
 * roster and waiting, starting the same round and handing the session
 * straight back, and asking one participant of a finished round again
 * in place.
 *
 * Apart from the rounds that weigh what a council said (`ask-weigh.ts`)
 * and the round over a whole stack (`ask-stack.ts`), because these
 * change with how a council is raised, dispatched and retried.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { lensFor, tooLargeToAsk } from "../../../lib/core/review/ask/prompt.ts";
import {
	type ChangeRef,
	councilNotEarned,
	councilPrompt,
	createRunStore,
	givenBy,
	guidanceFor,
	judgePrompt,
	type Roster,
	retryCannotResettle,
	retryWouldRepeat,
	runCouncil,
	runJudge,
	startCouncil,
	substituteOutcome,
} from "../../../lib/core/review/index.ts";
import type { ReviewerThinkingLevel } from "../../../lib/subagent/index.ts";
import {
	getParentPiInstall,
	ReviewerArtifactsStore,
	startReviewer,
} from "../../../lib/subagent/index.ts";
import { count } from "../../../lib/ui/count.ts";
import { runArtifactDir, runDir, sessionKey } from "../engine.ts";
import type { RoundWatch } from "../progress.ts";
import { GLYPH } from "../render.ts";
import { reviewerStarter } from "../reviewer.ts";
import { watchStartedRound } from "../round-job.ts";
import { roundReading } from "../round-reading.ts";
import { roundDispatched, roundOpened } from "../run-records.ts";
import { readFrom, treeForRound } from "../work.ts";
import { answerFor, keptOnLedger } from "./ask-answer.ts";
import {
	boundsForRound,
	contractSkill,
	deps,
	FENCED,
	fencePacks,
	firstResponseOf,
	ISOLATED,
	journalPack,
	keepsItsOwnClocks,
	substituting,
} from "./ask-reviewer.ts";
import { type RoundSeat, rosterOrThrow } from "./ask-roster.ts";
import {
	type AskParams,
	chartersFor,
	claimIdentities,
	councilFindingsBehind,
	material,
	nextSeq,
	renderFindings,
} from "./ask-round.ts";
import { type Answer, type boundFor, refuse, say } from "./shared.ts";

/** Ask every reviewer on the roster. */
export async function askCouncil(
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
	seat: RoundSeat,
	watch: RoundWatch,
): Promise<Answer> {
	const set = await councilRound(bound, change, params, seat);
	if (set.refused) return set.refused;
	const { roster, chosen, proposal, tree, charters, conventions, prompt } = set;

	const { run, warnings } = await runCouncil(
		{
			roster,
			prompt,
			seq: nextSeq(),
			...readFrom(tree, proposal.headCommit),
			...givenBy(ISOLATED, conventions),
		},
		deps(change, tree.path, watch, charters),
	);

	// The same call `opened` made, and guarded the same way. `keep`
	// removed the refusal that a missing opening write would have
	// caused; it does nothing about the failure that stopped that write
	// landing, and those are the realistic ones: no space, no
	// permission, a read-only volume. All of them fail this write too,
	// and bare it would answer a finished council with a refusal about
	// a ledger, throwing away every finding the round just paid for.
	const kept = await keptOnLedger(change, run);
	return say(
		[
			`Asked ${chosen}.`,
			answerFor(run, [...warnings, ...kept], tree.caveat),
		].join("\n"),
		{ run, warnings },
	);
}

/** How to ask a council about less, said when its prompt is too large. */
const NARROWER_COUNCIL =
	"Ask about fewer commits: a base the head is a few commits past, such as origin/main rather than a local main nobody pulls, or the change itself.";

/**
 * Everything a council round needs before it starts, as a council and
 * a background round both make it: the roster, the change's material,
 * the tree it reads, each reviewer's lens and the prompt. Or the
 * refusal, when the round isn't earned or no tree can be cut.
 */
async function councilRound(
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
	seat: RoundSeat,
) {
	const { roster, chosen } = await rosterOrThrow(params, "reviewers", seat);
	await claimIdentities(change, "reviewer", roster.reviewers);
	const { proposal, diff } = await material(bound);
	const unearned = await councilRefused(change, proposal.headCommit, params);
	if (unearned !== undefined) return { refused: refuse(unearned) };
	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		params.repo ?? seat.cwd,
	);
	if ("refusal" in tree) return { refused: refuse(tree.refusal) };
	// After the tree, because a lens can come from the repo under review
	// and that is the tree it comes from. Before the round, because a
	// reviewer running without the lens it was asked for files generic
	// findings under a specialist's name.
	const charters = await chartersFor(roster, tree, "reviewers", diff);
	const conventions = await guidanceFor(tree, diff);
	const prompt = councilPrompt({
		proposal,
		diff,
		...(params.intent === undefined ? {} : { intent: params.intent }),
		...conventions,
	});
	const tooLarge = tooLargeToAsk(prompt, NARROWER_COUNCIL);
	if (tooLarge !== undefined) return { refused: refuse(tooLarge) };
	return { roster, chosen, proposal, tree, charters, conventions, prompt };
}

/**
 * Why a council on `change` at `head` is refused, from the rounds the
 * change already holds, or nothing when it may go ahead. Asked before
 * the tree is cut, since a refused round needs none.
 */
async function councilRefused(
	change: ChangeRef,
	head: string | undefined,
	params: AskParams,
): Promise<string | undefined> {
	const earlier = await createRunStore(runDir()).list(change);
	return councilNotEarned(earlier, head, params.intent);
}

/**
 * Start a council and hand the session straight back.
 *
 * The same roster, prompt, tree and ledger entry a council makes,
 * dispatched and abandoned on purpose. What is given up is worth
 * saying out loud rather than discovering: no progress panel, since
 * nothing is listening; and no retry, since a retry substitutes into
 * a round that has finished. A reviewer a clock stops is still asked
 * for what it had: its own supervisor hands the wrap-up to another,
 * since nobody is waiting to ask, and a collect holds the round until
 * that answer is in.
 *
 * What is kept is everything durable. Each reviewer records findings
 * as it goes, its supervisor holds its own watchdogs, and `collect`
 * turns the directories back into findings whenever somebody asks.
 */
export async function startRound(
	bus: EventBus,
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
	seat: RoundSeat,
): Promise<Answer> {
	const set = await councilRound(bound, change, params, seat);
	if (set.refused) return set.refused;
	const { roster, chosen, proposal, tree, charters, conventions, prompt } = set;
	const bounding = await boundsForRound();
	const starter = reviewerStarter(getParentPiInstall(), runArtifactDir());
	const store = createRunStore(runDir());
	const contract = contractSkill("council");

	const artifacts = new ReviewerArtifactsStore(runArtifactDir());
	const { run, warnings, started } = await startCouncil(
		{
			roster,
			prompt,
			seq: nextSeq(),
			...readFrom(tree, proposal.headCommit),
			...givenBy(ISOLATED, conventions),
		},
		{
			now: () => new Date(),
			// Unguarded, unlike the council's. There the entry is
			// bookkeeping and the findings survive without it; here it is
			// the only thing that will ever say these seven directories
			// were a round, so failing to write it has to stop the round
			// rather than cost it later.
			opened: (opening) => {
				roundOpened(change, opening);
				return store.keep(change, { ...opening, startedBy: sessionKey() });
			},
			warmed: (participant, runId) => firstResponseOf(runId, participant.id),
			async start(participant, asked, runId) {
				await startReviewer({
					reviewer: {
						id: participant.id,
						...(participant.model === undefined
							? {}
							: { model: participant.model }),
						...(participant.thinkingLevel === undefined
							? {}
							: {
									thinkingLevel:
										participant.thinkingLevel as ReviewerThinkingLevel,
								}),
						...(participant.tools === undefined
							? {}
							: { tools: participant.tools }),
					},
					prompt: asked,
					cwd: tree.path,
					isolated: ISOLATED,
					env: FENCED,
					extraSkills: [contract],
					// Not optional here the way it is on the waiting path.
					// A detached reviewer's answer is only ever read off
					// disk, so a finding it did not write down before it
					// died is a finding nothing can recover.
					extraExtensions: [journalPack(), ...fencePacks()],
					...lensFor(charters.get(participant.id)),
					runId,
					stateDir: runArtifactDir(),
					startPi: starter,
					// The same per-participant resolution the waiting path
					// makes. A detached round is the one where a clock matters
					// most, since nobody is watching to notice a reviewer cut
					// off early.
					...bounding(participant),
				});
			},
		},
	);

	// Written back whatever happened, and this is the write that
	// matters. `startCouncil` settles the round it hands back when
	// nobody could be started, but settling a value settles nothing:
	// the ledger still holds the open entry written before dispatch.
	// Left there it is an alarm about a round that never ran, pointing
	// at directories that will always be empty.
	const kept = await keptOnLedger(change, run);
	// Its record says each reviewer until it ends, and anyone who could
	// not be started as failed.
	await roundDispatched(run.id);

	// Held as a job where a host is loaded, so the model is told when
	// the round is ready rather than polling for it. Only once something
	// was started, since a round that started nobody is already settled.
	const watched =
		started === 0
			? undefined
			: watchStartedRound({
					bus,
					runId: run.id,
					label: `council ${run.id} on ${change.label}`,
					participants: run.participants.map((participant) => participant.id),
					...roundReading(artifacts, run),
				});

	// Through the same composition as every other answer. This built
	// its own for as long as it existed, which is how it came to print
	// the tree caveat last and bare while the other seven answers put
	// the identical sentence second and marked, and how it came to
	// report six reviewers running on a round that started none.
	return say(
		[
			started === 0
				? `Started nothing for ${run.id}, so there is nothing to collect.`
				: `Started ${run.id} in the background: ${count(started, "reviewer")} running from ${chosen}, nothing waiting for them.`,
			...(started === 0
				? []
				: watched === undefined
					? [
							"Finish it with review_ask collect once they are done. Until then it reads as opened and never settled, which is what it is.",
						]
					: [
							`Held in the background as ${watched.id}: you will be told when no reviewer is left running, so do not poll. Collect it then. /jobs stops it.`,
						]),
			answerFor(run, [...warnings, ...kept], tree.caveat),
		].join("\n"),
		{ run, warnings },
	);
}

/** Ask one participant again, in place. */
export async function retryOne(
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
	seat: RoundSeat,
	watch: RoundWatch,
): Promise<Answer> {
	if (params.participant === undefined) {
		return refuse(
			"Say which participant to ask again, by the id the round recorded.",
		);
	}

	const store = createRunStore(runDir());
	const held =
		params.run === undefined
			? await store.latest(change, "council")
			: await store.byId(change, params.run);
	if (held === undefined) {
		return refuse(
			params.run === undefined
				? `No council has been asked about ${change.label}, so there is no round to retry into.`
				: `No round "${params.run}" is held against ${change.label}.`,
		);
	}

	// A round nobody has collected has no outcome to substitute for.
	// The description says a started round cannot be retried; without
	// this it is a sentence rather than a rule, and the failure lands
	// further in, where it reads as a bug rather than as an answer.
	if (held.open === true) {
		return refuse(
			`${held.id} was started and has not been collected, so there is no outcome to retry into. Collect it first, then retry whoever it says failed.`,
		);
	}

	const asked = held.participants.find((p) => p.id === params.participant);
	if (asked === undefined) {
		return refuse(
			`Round ${held.id} never asked "${params.participant}". It asked ${held.participants.map((p) => p.id).join(", ")}.`,
		);
	}

	// The round to change settings for is the next one, not this one.
	const resettles = retryCannotResettle(params.who, held, asked.id);
	if (resettles !== undefined) return refuse(resettles);

	const { roster } = await rosterOrThrow(params, "everybody", seat);
	const participant =
		roster.reviewers.find((r) => r.id === asked.id) ??
		(roster.judge?.id === asked.id ? roster.judge : undefined);
	if (participant === undefined) {
		return refuse(
			`The roster no longer names "${asked.id}", so it cannot be asked again. Re-add it to the config, or run a fresh round.`,
		);
	}

	// A stopped reviewer is not a failed one, and asking it again while
	// the clock that stopped it has not moved spends the same money to
	// meet the same wall. Refused rather than warned about: the whole
	// point is that the outcome is known in advance.
	//
	// Judged after the roster is read, because the clocks are this
	// participant's and the roster is where it keeps them. Against the
	// round's, a reviewer given a wall of its own would be refused on a
	// number it was never held to, and the refusal would name the knob
	// that does not move it.
	const before = held.outcomes.find((o) => o.participantId === asked.id);
	const repeats = retryWouldRepeat(
		before?.stopped,
		(await boundsForRound())(participant),
		// Named only when this one keeps clocks of its own, since that is
		// exactly when the round's knob is the wrong thing to be told to
		// raise.
		keepsItsOwnClocks(participant) ? participant.id : undefined,
	);
	if (repeats !== undefined) return refuse(repeats);

	await claimIdentities(change, asked.role, [participant]);
	const { proposal, diff } = await material(bound);
	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		params.repo ?? seat.cwd,
	);
	if ("refusal" in tree) return refuse(tree.refusal);
	// The one participant this retry re-asks, not the whole roster. It
	// has already been resolved above, so binding everybody would refuse
	// over somebody else's missing lens, which is the refusal the
	// narrowing exists to stop.
	const charters = await chartersFor(
		{ reviewers: [participant] },
		tree,
		"reviewers",
		diff,
	);
	const read = readFrom(tree, proposal.headCommit);
	const intent = params.intent === undefined ? {} : { intent: params.intent };
	// Asked again the way it was asked the first time, conventions
	// included, since a retry that reads a different prompt is not a
	// retry of the round it substitutes into.
	const conventions = await guidanceFor(tree, diff);
	// The attempt's conditions, which are not the round's. The fresh run
	// this builds is discarded once its outcome is lifted out, so these
	// ride on the outcome itself: a retry substitutes into a round that
	// may have been recorded before any of this existed, and writing
	// today's conditions onto that round would claim them for reviewers
	// who never ran under them.
	const given = givenBy(ISOLATED, conventions);
	// Retried in the role the round asked under, not always as a
	// reviewer. Re-running a judge through the council path would
	// record its findings with a reviewer's origin, and the
	// consolidation would become indistinguishable from the thing it
	// consolidated: exactly what the two rounds are kept apart for.
	const prompt =
		asked.role === "judge"
			? judgePrompt({
					proposal,
					diff,
					findings: renderFindings(
						await councilFindingsBehind(change, store, held.basis),
					),
					...intent,
					...conventions,
				})
			: councilPrompt({ proposal, diff, ...intent, ...conventions });
	// A retry is asked what its round was, so one too large to send then
	// is too large now, and waiting out a reviewer's clock says nothing.
	const tooLarge = tooLargeToAsk(prompt, NARROWER_COUNCIL);
	if (tooLarge !== undefined) return refuse(tooLarge);
	const { run: fresh, warnings } =
		asked.role === "judge"
			? await runJudge(
					{
						judge: participant,
						prompt,
						seq: 1,
						...read,
						...given,
					},
					substituting(deps(change, tree.path, watch, charters, held.id)),
				)
			: await runCouncil(
					{
						roster: { reviewers: [participant] } satisfies Roster,
						prompt,
						seq: 1,
						...read,
						...given,
					},
					substituting(deps(change, tree.path, watch, charters, held.id)),
				);

	const outcome = fresh.outcomes[0];
	if (outcome === undefined) {
		return refuse(`Asking "${asked.id}" again produced no outcome at all.`);
	}

	// Which tree this attempt read, not just which the round did. A
	// retry that fell back leaves the round less faithful than it was,
	// and until this was passed the fresh run carrying it was thrown
	// away, so the caveat here was inert and the comment above it
	// described something that did not happen.
	const updated = substituteOutcome(held, { ...outcome, ...given }, read);
	await store.replace(change, updated);
	return say(
		[
			`${GLYPH.finding} Asked ${asked.id} again in ${held.id}.`,
			// The whole answer, not just the head. Retrying is what a
			// reader does after being told a reviewer failed, so it is
			// the last place that should withhold the one diagnosis
			// saying a retry cannot work, and the first place to stop
			// saying it once the retry has disproved it.
			answerFor(updated, warnings, tree.caveat, {
				sessionAnswered: outcome.failure === undefined,
			}),
		].join("\n"),
		{ run: updated, warnings },
	);
}
