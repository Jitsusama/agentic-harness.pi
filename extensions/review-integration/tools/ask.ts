/**
 * `review_ask`: putting a change to other models.
 *
 * The rounds are separate kinds rather than one `run` with a mode,
 * because a council and a judge differ in what they are told, what
 * they are allowed to conclude, and how their findings are
 * attributed. Reading them back is `review_see findings`, and
 * deciding what to do about them is `review_draft decide`: this tool
 * only produces.
 *
 * Participants read a snapshot pinned to the commit under review,
 * cut through the working layer, so a change that is not checked out
 * here is still reviewed against its own code. When no working layer
 * is loaded, or the provider cannot say which commit is under review,
 * the round still runs against the caller's own tree and says so:
 * losing a council to a missing optional dependency would be worse
 * than a caveat, and reviewing the wrong code silently would be worse
 * than both.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	EventBus,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { lensFor } from "../../../lib/core/review/ask/prompt.ts";
import {
	type AskAnswer,
	type AskContext,
	type AskRound,
	type AskRun,
	auditPrompt,
	boundsFor,
	type ChangeRef,
	type CouncilDeps,
	type Critique,
	councilNotEarned,
	councilPrompt,
	createFindingStore,
	createIdentityLedger,
	createRunStore,
	critiquePrompt,
	type DiffModel,
	describeAnchor,
	describeRun,
	type Finding,
	givenBy,
	guidanceFor,
	judgePrompt,
	lensesFor,
	type Participant,
	type ParticipantOverride,
	type ReviewerBudget,
	type Roster,
	type RunStore,
	retryCannotResettle,
	retryWouldRepeat,
	reviewerBudget,
	runAudit,
	runCouncil,
	runCritique,
	runJudge,
	runStackCouncil,
	stackPrompt,
	startCouncil,
	substituteOutcome,
	type Thread,
	type ThreadAudit,
	touchedBy,
} from "../../../lib/core/review/index.ts";
import { sessionCwd, sessionKeyOf } from "../../../lib/core/session/index.ts";
import { loadPackageConfig } from "../../../lib/internal/config/loader.ts";
import { packageConfigPath } from "../../../lib/internal/paths.ts";
import { questLoadedIn } from "../../../lib/internal/quest/loaded.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import { SANDBOX_VARIABLE, STRICT } from "../../../lib/internal/sandbox.ts";
import {
	endsWithItsPrompts,
	runOrHandOff,
} from "../../../lib/jobs/hand-off.ts";
import { firstResponseBegun } from "../../../lib/subagent/first-response.ts";
import type { ReviewerThinkingLevel } from "../../../lib/subagent/index.ts";
import {
	getParentPiInstall,
	JOURNAL_PACK_PATH,
	ReviewerArtifactsStore,
	runReviewer,
	startReviewer,
	summarizeStreamActivity,
} from "../../../lib/subagent/index.ts";
import { fromScript } from "../../../lib/subagent/runpi/fresh.ts";
import { count } from "../../../lib/ui/count.ts";
import { REVIEW_SLUG } from "../config.ts";
import {
	answerDir,
	findingDir,
	personaDir,
	reviewEngine,
	runArtifactDir,
	runDir,
	sessionKey,
} from "../engine.ts";
import { answerWatching, type RoundWatch } from "../progress.ts";
import { rangeProposal } from "../range.ts";
import { GLYPH } from "../render.ts";
import {
	answerFromReviewer,
	keepAnswer,
	recordReviewerRun,
	reviewerRunner,
	reviewerStarter,
} from "../reviewer.ts";
import { builtInPersonaDir } from "../roster.ts";
import { watchStartedRound } from "../round-job.ts";
import { roundReading } from "../round-reading.ts";
import { roundToRead } from "../round-to-read.ts";
import { askedInRound, roundDispatched, roundOpened } from "../run-records.ts";
import { type ReadableTree, readFrom, treeForRound } from "../work.ts";
import { answerFor, judgeHandOff, keptOnLedger } from "./ask-answer.ts";
import {
	type RoundAsks,
	type RoundSeat,
	reportRoster,
	rosterOrThrow,
} from "./ask-roster.ts";
import { collectFinished, collectOne, stopRound } from "./ask-settle.ts";
import { person } from "./heard.ts";
import {
	type Answer,
	boundFor,
	hostedChange,
	messageOf,
	refuse,
	reviewedChange,
	say,
	type TargetParams,
} from "./shared.ts";

/** What the tool can be asked to do. */
type AskAction =
	| "council"
	| "start"
	| "stop"
	| "judge"
	| "critique"
	| "audit"
	| "stack"
	| "runs"
	| "roster"
	| "collect"
	| "retry"
	| "release";

/**
 * Which ids mean what, for as long as this module is loaded.
 *
 * A session's worth of rounds is the scope that matters: within one,
 * a reader comparing two findings by their reviewer id has to be able
 * to trust the comparison. Across sessions the ledger is rebuilt, and
 * the findings themselves still carry the run they came from.
 */
const ledger = createIdentityLedger();

/** What a call of `review_ask` passes. */
export interface AskParams extends TargetParams {
	action?: AskAction;
	intent?: string;
	participant?: string;
	run?: string;
	set?: string;
	who?: Record<string, ParticipantOverride>;
}

/** Where this call is being asked from. */
async function seatFor(
	ctx: ExtensionContext,
	params: AskParams,
	change?: ChangeRef,
): Promise<RoundSeat> {
	const quest = await questLoadedIn(ctx.sessionManager.getSessionId());
	return {
		cwd: sessionCwd(ctx),
		said: person.said,
		place: {
			...(params.set === undefined ? {} : { set: params.set }),
			...(quest === undefined ? {} : { quest }),
			...(change === undefined ? {} : { project: change.repo.key }),
		},
		...(ctx.model === undefined
			? {}
			: { sessionModel: `${ctx.model.provider}/${ctx.model.id}` }),
	};
}

/**
 * Do what a `review_ask` call asks, once the tool is first called: a
 * round still going after a minute moves to a job.
 */
export async function runAsk(
	pi: ExtensionAPI,
	toolCallId: string,
	params: AskParams,
	callSignal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<Answer> {
	const action = params.action ?? "runs";
	// A round runs for minutes, deaf to the person and the mesh while
	// it holds the turn, so one still going after a minute moves to a
	// job, as a long command does.
	return await runOrHandOff<unknown>({
		kind: "review",
		label: `${action} on ${params.change ?? "the attached change"}`,
		noun: "background round",
		filePrefix: "pi-review-ask",
		stopping: (jobId) =>
			`To stop it, call the jobs tool's stop with ${jobId} (load it with tool_search), which stops every reviewer and keeps what they wrote. The person can stop it with /jobs.`,
		quiet: "Its board shows how far each reviewer has got.",
		toolCallId,
		session: sessionKeyOf(ctx),
		nested: endsWithItsPrompts(ctx.mode),
		signal: callSignal,
		onUpdate: undefined,
		bus: pi.events,
		run: (signal) => answerAsk(signal),
	});

	// One watch per call rather than one per round helper, so the
	// board and the signal are the same objects everything sees, and
	// every board this call opens comes down as its answer is handed
	// back, including the answer to a round that threw.
	function answerAsk(signal: AbortSignal): Promise<Answer> {
		return answerWatching(ctx, signal, async (watch) => {
			try {
				// Before the change is bound, because this one is about the
				// roster and not about any change. Binding first made the
				// listing refuse from exactly the position it exists to be
				// reachable from: deciding who to ask, before attaching
				// anything to ask them about.
				if (action === "roster") {
					return await reportRoster(await seatFor(ctx, params));
				}

				const bound = await boundFor(pi, params, sessionCwd(ctx));
				const change = reviewedChange(bound);
				if (change === undefined) {
					return refuse(
						"A list of refs is put to the roster all together with action stack. Every other round takes a hosted change, or a local range as base and head.",
					);
				}

				const seat = await seatFor(ctx, params, change);
				switch (action) {
					case "runs":
						return await reportRuns(change);
					case "collect":
						return await collectOne(change, params);
					case "council":
						return await askCouncil(
							bound,
							change,
							params,
							seat,
							watch("council"),
						);
					case "start":
						return await startRound(pi.events, bound, change, params, seat);
					case "stop":
						return await stopRound(change, params);
					case "judge":
						return await askJudge(bound, change, params, seat, watch("judge"));
					case "critique":
						return await askCritique(
							bound,
							change,
							params,
							seat,
							watch("critique"),
						);
					case "audit":
						return await askAudit(bound, change, params, seat, watch("audit"));
					case "stack":
						return await askStack(pi, bound, params, seat, watch("stack"));
					case "retry":
						return await retryOne(
							bound,
							change,
							params,
							seat,
							watch("council"),
						);
					case "release":
						return releaseIdentity(params);
				}
			} catch (error) {
				return refuse(messageOf(error));
			}
		});
	}
}

/** What has been asked about this change so far. */
async function reportRuns(change: ChangeRef): Promise<Answer> {
	const runs = await createRunStore(runDir()).list(change);
	if (runs.length === 0) {
		return say(
			`Nothing has been asked about ${change.label} yet. Run a council to start.`,
			{ runs: [] },
		);
	}
	const lines = runs.map((run) => describeRun(run));
	return say(
		[`${count(runs.length, "round")} on ${change.label}:`, ...lines].join("\n"),
		{ runs },
	);
}

/** Ask every reviewer on the roster. */
async function askCouncil(
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
	seat: RoundSeat,
	watch: RoundWatch,
): Promise<Answer> {
	const { roster, chosen } = await rosterOrThrow(params, "reviewers", seat);
	await claimIdentities(change, "reviewer", roster.reviewers);
	const { proposal, diff } = await material(bound);
	const unearned = await councilRefused(change, proposal.headCommit, params);
	if (unearned !== undefined) return refuse(unearned);
	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		params.repo ?? seat.cwd,
	);
	if ("refusal" in tree) return refuse(tree.refusal);
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
 * nothing is listening; no wrap-up for a reviewer that runs long,
 * since a wrap-up is dispatched by whoever was waiting; and no
 * retry, since a retry substitutes into a round that has finished.
 *
 * What is kept is everything durable. Each reviewer records findings
 * as it goes, its supervisor holds its own watchdogs, and `collect`
 * turns the directories back into findings whenever somebody asks.
 */
async function startRound(
	bus: EventBus,
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
	seat: RoundSeat,
): Promise<Answer> {
	const { roster, chosen } = await rosterOrThrow(params, "reviewers", seat);
	await claimIdentities(change, "reviewer", roster.reviewers);
	const { proposal, diff } = await material(bound);
	const unearned = await councilRefused(change, proposal.headCommit, params);
	if (unearned !== undefined) return refuse(unearned);
	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		params.repo ?? seat.cwd,
	);
	if ("refusal" in tree) return refuse(tree.refusal);
	const charters = await chartersFor(roster, tree, "reviewers", diff);
	const conventions = await guidanceFor(tree, diff);
	const prompt = councilPrompt({
		proposal,
		diff,
		...(params.intent === undefined ? {} : { intent: params.intent }),
		...conventions,
	});
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

/** Ask the judge to consolidate the latest council. */
async function askJudge(
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
	seat: RoundSeat,
	watch: RoundWatch,
): Promise<Answer> {
	const { roster } = await rosterOrThrow(params, "judge", seat);
	if (roster.judge === undefined) {
		return refuse(
			"This roster names no judge, so there is nobody to consolidate with. Add a judge to the config, with an id of its own: a judge reads what the reviewers said, so it cannot share a reviewer's name.",
		);
	}

	const store = createRunStore(runDir());
	const collected = await collectFinished(change);
	const chosen = await roundToRead(store, change, "council", params.run);
	if ("refusal" in chosen) return refuse(chosen.refusal);
	if ("none" in chosen) {
		// A started round is on the ledger and unfinished, and `latest`
		// only returns finished ones, so without this the answer to "a
		// council is running, judge it" is "run a council": the one
		// instruction that costs another roster and still will not work.
		return refuse(
			collected.running.length === 0
				? `No council has been asked about ${change.label}, so there is nothing to consolidate. Run a council first.`
				: `A council on ${change.label} is still running, so there is nothing consolidated to judge yet. ${collected.running.join(" ")}`,
		);
	}

	const council = chosen.run;
	await claimIdentities(change, "judge", [roster.judge]);
	const raised = await findingsOf(change, council);
	const { proposal, diff } = await material(bound);
	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		params.repo ?? seat.cwd,
	);
	if ("refusal" in tree) return refuse(tree.refusal);
	const charters = await chartersFor(roster, tree, "judge", diff);
	const conventions = await guidanceFor(tree, diff);
	const prompt = judgePrompt({
		proposal,
		diff,
		findings: renderFindings(raised),
		...(params.intent === undefined ? {} : { intent: params.intent }),
		...conventions,
	});
	const { run, warnings } = await runJudge(
		{
			judge: roster.judge,
			prompt,
			seq: nextSeq(),
			...readFrom(tree, proposal.headCommit),
			...givenBy(ISOLATED, conventions),
		},
		deps(change, tree.path, watch, charters),
	);

	// Upserted, not appended. This round wrote itself down before it
	// asked anybody, so appending here files it twice under one id and
	// leaves the first copy open forever: protected, never swept, and
	// nagging at every session start. A settle is the same round
	// arriving in its finished state, which is what `keep` means.
	await store.keep(change, { ...run, basis: council.id });
	return say(
		[
			...collected.said,
			`It consolidated ${council.id}.`,
			answerFor(run, warnings, tree.caveat),
			...judgeHandOff(run),
		].join("\n"),
		{ run, warnings },
	);
}

/**
 * Ask the roster to push back on what the judge concluded.
 *
 * Positions are recorded on the run rather than as findings, so a
 * critique is readable beside the findings it challenges instead of
 * being mixed into them.
 */
async function askCritique(
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
	seat: RoundSeat,
	watch: RoundWatch,
): Promise<Answer> {
	const { roster } = await rosterOrThrow(params, "reviewers", seat);
	await claimIdentities(change, "reviewer", roster.reviewers);

	const store = createRunStore(runDir());
	const chosen = await roundToRead(store, change, "judge", params.run);
	if ("refusal" in chosen) return refuse(chosen.refusal);
	if ("none" in chosen) {
		return refuse(
			`No judge has consolidated anything on ${change.label}, so there is nothing settled enough to push back on. Run a council, then a judge.`,
		);
	}
	const judged = chosen.run;

	const raised = await findingsOf(change, judged);
	const { proposal, diff } = await material(bound);
	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		params.repo ?? seat.cwd,
	);
	if ("refusal" in tree) return refuse(tree.refusal);
	const charters = await chartersFor(roster, tree, "reviewers", diff);
	const conventions = await guidanceFor(tree, diff);

	const asking = deps(change, tree.path, watch, charters);
	const { run, critiques, warnings } = await runCritique(
		{
			roster,
			prompt: critiquePrompt({
				proposal,
				diff,
				findings: renderFindings(raised),
				...(params.intent === undefined ? {} : { intent: params.intent }),
				...conventions,
			}),
			seq: nextSeq(),
			findingIds: raised.map((finding) => finding.id),
			...readFrom(tree, proposal.headCommit),
			...givenBy(ISOLATED, conventions),
		},
		{
			ask: asking.ask,
			warmed: asking.warmed,
			now: () => new Date(),
			progress: watch.progress,
		},
	);

	await store.record(change, { ...run, basis: judged.id });
	return say(
		[
			`It pushed back on ${judged.id}.`,
			answerFor(run, warnings, tree.caveat),
			...(critiques.length === 0
				? ["Nobody took a position."]
				: ["", ...describeCritiques(critiques)]),
		].join("\n"),
		{ run, critiques, warnings },
	);
}

/**
 * Ask the roster about the whole stack at once.
 *
 * Every change is put to every reviewer together, which is the only
 * way a finding that lives between changes can be seen at all. The
 * tree is cut at the tip, since the tip's checkout holds every change
 * below it: a stack applies in order, so reading the tip is reading
 * the stack as it will land.
 */
async function askStack(
	pi: ExtensionAPI,
	bound: Awaited<ReturnType<typeof boundFor>>,
	params: AskParams,
	seat: RoundSeat,
	watch: RoundWatch,
): Promise<Answer> {
	const { roster } = await rosterOrThrow(params, "reviewers", seat);

	const stack = await bound.stack();
	if (!stack) {
		return refuse(
			`The ${bound.provider.id} provider does not read stacks, so there is no stack to put to anybody. Ask about the one change with review_ask council.`,
		);
	}

	// A node's own ref is a git ref and its proposal's ref is a
	// ChangeRef. Both are called ref and they are not the same thing, so
	// they stay in separate fields rather than being spread together.
	const proposed = stack.nodes.flatMap((node) =>
		node.change === undefined ? [] : [{ ref: node.ref, proposal: node.change }],
	);
	if (proposed.length === 0) {
		return refuse(
			"No branch in this stack has been proposed as a change, so there is nothing to read. A stack of branches nobody has proposed is still a stack, but it carries no bodies or diffs to review.",
		);
	}

	const { engine } = await reviewEngine(pi);
	const changes = await Promise.all(
		proposed.map(async ({ ref, proposal }) => {
			const target = await engine.bound(proposal.ref);
			return {
				ref,
				change: proposal.ref,
				proposal,
				diff: await target.diffModel(),
			};
		}),
	);

	await Promise.all(
		changes.map((one) =>
			claimIdentities(one.change, "reviewer", roster.reviewers),
		),
	);

	const tip = changes[changes.length - 1];
	if (tip === undefined) {
		return refuse("This stack reports no changes to read.");
	}
	const tree = await treeForRound(
		bound.repo,
		tip.proposal.headCommit,
		params.repo ?? seat.cwd,
	);
	if ("refusal" in tree) return refuse(tree.refusal);
	// Every change in the stack, since a lens the stack edits anywhere
	// is a lens the stack's author wrote. A node carrying no proposal
	// carries no diff, and the tree read is the tip, which holds its
	// work anyway: what the stack touches is then unknowable rather than
	// merely smaller, so it is said rather than understated.
	const charters = await chartersFor(
		roster,
		tree,
		"reviewers",
		stack.nodes.length === proposed.length
			? { files: changes.flatMap((one) => one.diff.files) }
			: {
					unknown: `${stack.nodes.length - proposed.length} of this stack's ${stack.nodes.length} branches have not been put up as changes, so they carry no diff, and the tree read is the tip that holds their work.`,
				},
	);

	const stackRefs = changes.map((one) => one.ref);
	const witnesses = new Map(
		changes.map((one) => [one.ref, one.proposal.headCommit]),
	);
	const changeFor = new Map(changes.map((one) => [one.ref, one.change]));
	const findings = createFindingStore(findingDir());

	// The same honest answer the charters get twenty lines up: a stack
	// whose nodes are not all proposed knows less about what it touches
	// than the tree it reads contains.
	const conventions = await guidanceFor(
		tree,
		stack.nodes.length === proposed.length
			? { files: changes.flatMap((one) => one.diff.files) }
			: { unknown: "not every branch in this stack is proposed" },
	);
	const asking = deps(tip.change, tree.path, watch, charters);
	const { run, warnings } = await runStackCouncil(
		{
			roster,
			prompt: stackPrompt({
				changes: changes.map((one) => ({
					ref: one.ref,
					proposal: one.proposal,
					diff: one.diff,
				})),
				...(params.intent === undefined ? {} : { intent: params.intent }),
				...conventions,
			}),
			seq: nextSeq(),
			stackRefs,
			witnessFor: (ref) => witnesses.get(ref),
			// Per-change witnesses, but one tree, so the caveat is about
			// the round exactly as it is for every other kind.
			...(tree.caveat === undefined ? {} : { unpinned: tree.caveat }),
			...givenBy(ISOLATED, conventions),
		},
		{
			ask: asking.ask,
			warmed: asking.warmed,
			async record(ref, raised) {
				const change = changeFor.get(ref);
				if (change === undefined) return [];
				return await findings.record(change, raised);
			},
			now: () => new Date(),
			// The longest round of all: it reads every change in the stack.
			progress: watch.progress,
		},
	);

	// Recorded against the tip, because a stack round is one round and
	// splitting it across every change would make it unreadable as the
	// single thing it was.
	await createRunStore(runDir()).record(tip.change, run);
	return say(
		[
			`${stackRefs.length} changes put to ${roster.reviewers.length} reviewers together.`,
			answerFor(run, warnings, tree.caveat),
		].join("\n"),
		{ run, warnings, refs: stackRefs },
	);
}

/**
 * Judge the inbound threads against the change.
 *
 * Advisory by construction: it never posts and raises no findings.
 * Answering a thread is a decision about how to talk to a person, and
 * this only makes it a better informed one.
 */
async function askAudit(
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
	seat: RoundSeat,
	watch: RoundWatch,
): Promise<Answer> {
	const { roster } = await rosterOrThrow(params, "judge", seat);
	// The judge audits, because weighing what exists against a change
	// is the judging role and a roster should not need a fourth kind of
	// participant to say so.
	const auditor = roster.judge;
	if (auditor === undefined) {
		return refuse(
			"This roster names no judge, and auditing is a judging job: it weighs what people asked for against what the change does. Add a judge to the config.",
		);
	}
	await claimIdentities(change, "judge", [auditor]);

	// A range's change is this harness's name for it, which a host's
	// conversation would read as one of its own changes.
	if (!bound.conversation || !hostedChange(bound)) {
		return refuse(
			"Nothing hosts this target, so it carries no threads to audit.",
		);
	}
	const threads = await bound.conversation.threads(change);
	const open = threads.filter((thread) => !thread.resolved);
	if (open.length === 0) {
		return say(
			`Every thread on ${change.label} is resolved, so there is nothing to audit.`,
			{ audits: [] },
		);
	}

	const { proposal, diff } = await material(bound);
	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		params.repo ?? seat.cwd,
	);
	if ("refusal" in tree) return refuse(tree.refusal);

	// Indices are the ones a person cites, meaning the position in the
	// full thread listing rather than among the unresolved ones. An
	// audit that renumbered them would send somebody to the wrong
	// thread, which is the same harm the elsewhere standing exists to
	// avoid.
	const indexOf = new Map(threads.map((thread, at) => [thread.id, at + 1]));
	const charters = await chartersFor(roster, tree, "judge", diff);
	const threadIndices = open.flatMap((thread) => {
		const at = indexOf.get(thread.id);
		return at === undefined ? [] : [at];
	});

	const conventions = await guidanceFor(tree, diff);
	const { run, audits, warnings } = await runAudit(
		{
			auditor,
			prompt: auditPrompt({
				proposal,
				diff,
				threads: renderThreads(open, indexOf),
				...(params.intent === undefined ? {} : { intent: params.intent }),
				...conventions,
			}),
			seq: nextSeq(),
			threadIndices,
			...readFrom(tree, proposal.headCommit),
			...givenBy(ISOLATED, conventions),
		},
		{
			ask: deps(change, tree.path, watch, charters).ask,
			now: () => new Date(),
			progress: watch.progress,
		},
	);

	await createRunStore(runDir()).record(change, run);
	return say(
		[
			answerFor(run, warnings, tree.caveat),
			...(audits.length === 0
				? ["No thread was judged."]
				: ["", ...describeAudits(audits)]),
		].join("\n"),
		{ run, audits, warnings },
	);
}

/** Threads as an auditor reads them, by the index a person cites. */
function renderThreads(
	threads: readonly Thread[],
	indexOf: ReadonlyMap<string, number>,
): string {
	return threads
		.map((thread) => {
			const at = indexOf.get(thread.id) ?? 0;
			const where = thread.anchor
				? describeAnchor(thread.anchor)
				: "the change";
			const said = thread.comments
				.map((comment) => `  ${comment.author.name}: ${comment.body}`)
				.join("\n");
			return `[T${at}] ${where}${thread.stale ? " (anchor may be stale)" : ""}\n${said}`;
		})
		.join("\n\n");
}

/** Standings, in the order the threads were put up. */
function describeAudits(audits: readonly ThreadAudit[]): string[] {
	return audits.map((audit) =>
		[
			`[T${audit.threadIndex}] ${audit.standing}: ${audit.rationale}`,
			...(audit.evidence === undefined ? [] : [`  seen at ${audit.evidence}`]),
		].join("\n"),
	);
}

/** Positions as a reader weighs them, grouped by finding. */
function describeCritiques(critiques: readonly Critique[]): string[] {
	const byFinding = new Map<number, Critique[]>();
	for (const critique of critiques) {
		const held = byFinding.get(critique.findingId) ?? [];
		held.push(critique);
		byFinding.set(critique.findingId, held);
	}
	return [...byFinding.entries()].flatMap(([findingId, held]) => [
		`[F${findingId}]`,
		...held.map(
			(critique) =>
				`  ${critique.participantId} ${critique.position}: ${critique.rationale}`,
		),
	]);
}

/** Ask one participant again, in place. */
async function retryOne(
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
	const { run: fresh, warnings } =
		asked.role === "judge"
			? await runJudge(
					{
						judge: participant,
						prompt: judgePrompt({
							proposal,
							diff,
							findings: renderFindings(
								await councilFindingsBehind(change, store, held.basis),
							),
							...intent,
							...conventions,
						}),
						seq: 1,
						...read,
						...given,
					},
					substituting(deps(change, tree.path, watch, charters, held.id)),
				)
			: await runCouncil(
					{
						roster: { reviewers: [participant] } satisfies Roster,
						prompt: councilPrompt({
							proposal,
							diff,
							...intent,
							...conventions,
						}),
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

/**
 * Free an id, so it can mean something else.
 *
 * The escape hatch the refusal names. It is deliberately explicit
 * rather than automatic: releasing one costs the ability to tell which
 * participant older findings came from, and that is a person's call
 * rather than a convenience the tool applies quietly.
 */
function releaseIdentity(params: AskParams): Answer {
	if (params.participant === undefined) {
		return refuse(
			"Say which participant id to release. Releasing one lets it mean a different model, at the cost of its existing findings no longer identifying who raised them.",
		);
	}
	if (!ledger.release(params.participant)) {
		return say(
			`Nothing holds "${params.participant}", so it is already free to mean whatever the roster says.`,
			{ released: false },
		);
	}
	return say(
		`Released "${params.participant}". Findings already attributed to it keep that name, so they no longer say which participant raised them.`,
		{ released: true },
	);
}

/**
 * Hold every participant to what its id means, before asking any.
 *
 * Checked up front rather than per participant, so a round either runs
 * whole or refuses whole. Discovering the conflict after four of six
 * models had answered would leave a round nobody can read, and a bill
 * for it.
 */
async function claimIdentities(
	change: ChangeRef,
	role: "reviewer" | "judge",
	participants: readonly Participant[],
): Promise<void> {
	const raised = await createFindingStore(findingDir()).list(change);
	for (const participant of participants) {
		const outcome = ledger.claim(role, participant, raised);
		if ("refusal" in outcome) throw new Error(outcome.refusal);
	}
}

/** Whether this participant's limits come from its own entry. */
function keepsItsOwnClocks(participant: Participant): boolean {
	return (
		participant.backstopMs !== undefined ||
		participant.idleMs !== undefined ||
		participant.answerMs !== undefined
	);
}

/**
 * Keep one answer, and never let keeping it cost the round.
 *
 * A full disk or a read-only state directory is a reason to lose the
 * archive, not a reason to lose the findings the reviewer just spent
 * ten minutes producing.
 */
async function keptAt(
	runId: string,
	participantId: string,
	text: string,
): Promise<string | undefined> {
	try {
		return await keepAnswer(answerDir(), runId, participantId, text);
	} catch {
		return undefined;
	}
}

/**
 * What bounds this round's reviewers, as configured.
 *
 * Read from the same section the roster comes from, because who is
 * asked and how long they get are one decision about one fan-out.
 * Falls back to the defaults for any config that cannot be read: a
 * round is better bounded generously than refused over a budget.
 *
 * Hands back a way to ask about one participant rather than the budget
 * itself, because a participant may keep clocks of its own and every
 * place that bounds a reviewer has to narrow to it. A round budget
 * that could be spread straight into a spawn is a round budget that
 * will be, at whichever of the three sites somebody forgets, and that
 * join is the failure this project keeps making. A function cannot be
 * spread, so forgetting stops compiling.
 */
async function boundsForRound(): Promise<
	(participant: Participant) => ReviewerBudget
> {
	const loaded = await loadPackageConfig(packageConfigPath());
	const review = loaded.ok ? loaded.config.sections[REVIEW_SLUG] : undefined;
	const round = reviewerBudget(
		isRecord(review) ? (review as { ask?: unknown }).ask : undefined,
	);
	return (participant) => boundsFor(participant, round);
}

/**
 * The output contract for one round.
 *
 * A path rather than prose, because it is loaded into the subagent as a
 * skill. Resolved from this file so it works whatever directory the
 * session was started in.
 */
function contractSkill(round: AskRound): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(
		here,
		"..",
		"..",
		"..",
		"skills",
		`review-${round}-format`,
		"SKILL.md",
	);
}

/**
 * The rounds where writing a finding down as you find it makes sense.
 *
 * The finding-shaped ones. A critique states positions on findings
 * somebody else raised and an audit states standings on threads, so
 * neither has anything to record, and offering the tool would invite
 * an answer in the wrong shape.
 */
const RECORDS_FINDINGS: ReadonlySet<AskRound> = new Set([
	"council",
	"judge",
	"stack",
]);

/**
 * The pack that lets a reviewer write a finding down mid-investigation.
 *
 * Outside `extensions/` deliberately: pi scans that directory, and this
 * tool belongs to a reviewer subagent rather than to the session that
 * dispatched one.
 */
function journalPack(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	// The location comes from the library, beside the name of the tool
	// this file registers. They are one fact: this loads the pack and
	// then permits that tool by name, and a rename that moves one
	// without the other leaves a reviewer told to call something
	// nothing has registered.
	// Checked at the read, because this is the exact line that took a
	// council down: the constant had just been added to a script
	// module, the session had reloaded rather than restarted, and
	// splitting undefined threw once per reviewer with nothing in the
	// message naming a module or a remedy.
	const path = fromScript(
		JOURNAL_PACK_PATH,
		"JOURNAL_PACK_PATH",
		"lib/subagent/runpi/journal.mjs",
	);
	return join(here, "..", "..", "..", ...path.split("/"));
}

/**
 * Settles once a reviewer's first response has begun, read from the
 * log its supervisor keeps, or once waiting stops being worth it.
 *
 * Both runners write that log in the same place, so the waiting round
 * and the detached one wait the same way.
 */
async function firstResponseOf(
	runId: string,
	participantId: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const { eventsPath } = new ReviewerArtifactsStore(runArtifactDir()).paths(
		runId,
		participantId,
	);
	return await firstResponseBegun(eventsPath, {
		withinMs: FIRST_RESPONSE_WAIT_MS,
		...(signal === undefined ? {} : { signal }),
	});
}

/**
 * The next round's place among those this session has started.
 *
 * A run's id is its kind, the millisecond it started and this, and
 * each round here used to pass 1. Two rounds started in the same
 * millisecond, which a script starting several at once does, then had
 * one id: their reviewers shared one artifact directory and one lease
 * apiece, so some would not start and the rest wrote over each other.
 * Counted for the session, so a round's sequence is also how many this
 * session has started; two sessions in one millisecond stay possible
 * and are far rarer.
 */
let roundsStarted = 0;
export function nextSeq(): number {
	roundsStarted += 1;
	return roundsStarted;
}

/**
 * The longest the rest of a round waits on its first reviewer.
 *
 * Its first response normally begins within half a minute: a few
 * seconds for pi to start and the rest for the model to read the
 * brief. Past this the first reviewer is stuck or the brief is
 * enormous, and the rest go ahead and pay for the brief themselves, as
 * every reviewer did before rounds waited at all.
 */
const FIRST_RESPONSE_WAIT_MS = 120_000;

/**
 * Each participant's charter, from the operator's personas and the
 * repo's own agents together.
 *
 * The composition itself lives in `lenses.ts`, where it can be driven
 * against a directory. What stays here is the one decision this side
 * owns: where an operator's personas live, which is an environment
 * question and not a review one.
 */
function chartersFor(
	roster: Roster,
	tree: ReadableTree,
	// The same word the roster was read under, so a round binds lenses
	// for the half it asks and no other. A judge-only round refusing
	// over a reviewer's missing lens is a refusal about somebody who was
	// never going to be asked.
	asks: RoundAsks,
	// What the change touches, or why that is not known. A lens the
	// change itself wrote is refused rather than obeyed: a charter is
	// the reviewer's standing instruction, and the tree it is read from
	// is the commit under review.
	touched: DiffModel | { unknown: string },
): Promise<Map<string, string>> {
	const judge = asks === "reviewers" ? undefined : roster.judge;
	// Yours first, so a charter you wrote under a built-in's name
	// replaces the one the package ships.
	const dirs = [personaDir(), builtInPersonaDir()];
	return lensesFor(
		{
			reviewers: asks === "judge" ? [] : roster.reviewers,
			...(judge === undefined ? {} : { judge }),
		},
		dirs,
		"unknown" in touched ? touched : touchedBy(touched),
		tree,
	);
}

/**
 * Whether a reviewer inherits the machine it runs on.
 *
 * It did, and three things came in that way. The operator's own
 * skills, so the same change reviewed on two machines got two
 * different councils and neither said why. Every extension pi could
 * discover, loaded into a child nobody meant to give them to. And the
 * context files in the working directory, which for a reviewer is a
 * tree pinned to the commit under review: the change's own AGENTS.md,
 * read as standing instruction, written by the author of the change.
 *
 * The last one is the same hole the repo-lens rule closed, sitting
 * open beside it and needing no opt-in at all. Measured with a file
 * that told a child to answer every question with one word, which it
 * then did.
 *
 * A round now says what its reviewers get: the output contract, the
 * journal, the charter, and the repo's conventions as quoted material
 * in the prompt. A constant rather than a literal at two call sites,
 * because a reviewer that waits and a reviewer that is left running
 * must not differ in what they inherit.
 */
const ISOLATED = true;

/**
 * What every reviewer's pi runs under: the strict sandbox, always and
 * for every round, since each reads a change a stranger may have
 * written, and one rule is easier to trust than a choice. Given to each
 * run as it starts, so a resumed or retried reviewer takes it from the
 * round that starts it, never from a run saved earlier.
 */
const FENCED = { [SANDBOX_VARIABLE]: STRICT } as const;

/**
 * The extensions that hold a reviewer to that sandbox, by their place
 * in this package. `ISOLATED` loads none of the session's, and a
 * reviewer runs no commands, so the sandbox alone would fence nothing:
 * these hold its file tools to the fence and scrub credentials from
 * what they answer, before a finding could quote one onto the change.
 */
const FENCE_EXTENSIONS = [
	"extensions/sandbox-file-interceptor/index.ts",
	"extensions/secret-scrub-interceptor/index.ts",
] as const;

/** The fence's extensions, where this package has them. */
export function fencePacks(): string[] {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
	return FENCE_EXTENSIONS.map((path) => join(root, ...path.split("/")));
}

/**
 * The change and its diff, which every round needs. A local range has no
 * proposal of its own to read, so its commits stand in for one.
 */
async function material(bound: Awaited<ReturnType<typeof boundFor>>) {
	const [hosted, diff] = await Promise.all([
		bound.proposal(),
		bound.diffModel(),
	]);
	const proposal = hosted ?? (await rangeProposal(bound));
	if (!proposal) {
		throw new Error(
			"This provider cannot read the change itself, so there is nothing to put to a reviewer.",
		);
	}
	return { proposal, diff };
}

/**
 * The impure things a round needs, over the subagent engine and the
 * finding store.
 *
 * The child is pinned to the parent's own pi install rather than to
 * whatever `pi` resolves to on PATH, so a reviewer runs the same
 * build as the session that asked it.
 */
function deps(
	change: ChangeRef,
	cwd: string,
	watch: RoundWatch,
	charters: ReadonlyMap<string, string> = new Map(),
	// Which round the spend belongs to, when that is not the round
	// doing the asking. A retry runs a throwaway round and substitutes
	// its outcome into the held one, so billing it to the id it ran
	// under files the money against a round the ledger never names and
	// leaves the round that actually paid under-reporting forever. The
	// artifacts still go under the fresh id, because the transcript
	// belongs to the attempt that produced it.
	billTo?: string,
) {
	const findings = createFindingStore(findingDir());
	// The watch knows which round this is, so it is not passed twice.
	const contract = contractSkill(watch.round);
	// Read once for the round rather than once per participant, and
	// started here rather than awaited, so seven reviewers share one
	// config read without any of them waiting on it to be asked.
	const bounds = boundsForRound();
	return {
		warmed: (participant: Participant, runId: string) =>
			firstResponseOf(runId, participant.id, watch.signalFor(participant.id)),
		// Said in the round's run record while it goes on, for the launcher.
		ask: (
			participant: Participant,
			prompt: string,
			context: AskContext,
		): Promise<AskAnswer> =>
			askedInRound(change, watch.round, context.runId, participant, () =>
				askOne(participant, prompt, context),
			),
		record(raised: Omit<Finding, "id">[]) {
			return findings.record(change, raised);
		},
		now: () => new Date(),
		// Written down before the first reviewer is dispatched, so the
		// most expensive thing this tool does stops being the one thing
		// nothing records until it is over. Recorded rather than
		// replaced, since at this point the round is new.
		async opened(run: AskRun) {
			roundOpened(change, run);
			try {
				await createRunStore(runDir()).keep(change, {
					...run,
					startedBy: sessionKey(),
				});
			} catch {
				// Bookkeeping must not cost the round. A ledger that could
				// not be written is worth less than seven reviews, and the
				// settled write at the end will say so again anyway.
			}
		},
		// Every round reports. A round that fans out and says nothing for
		// minutes is indistinguishable from one that has hung, which is
		// the whole reason this exists.
		progress: watch.progress,
	};

	async function askOne(
		participant: Participant,
		prompt: string,
		context: AskContext,
	): Promise<AskAnswer> {
		// This participant's, which is the round's unless it keeps its
		// own. Resolved here rather than once for the round, because a
		// clock sized for the slowest member is a clock every faster
		// member is also held to.
		const budget = (await bounds)(participant);
		// Taken here rather than from the result, since what a run cost
		// in wall time is a fact about the round and the runner does
		// not report one.
		const startedAt = Date.now();
		const result = await runReviewer({
			reviewer: {
				id: participant.id,
				...(participant.model === undefined
					? {}
					: { model: participant.model }),
				...(participant.thinkingLevel === undefined
					? {}
					: {
							thinkingLevel: participant.thinkingLevel as ReviewerThinkingLevel,
						}),
				...(participant.tools === undefined
					? {}
					: { tools: participant.tools }),
			},
			prompt,
			cwd,
			isolated: ISOLATED,
			// The round's output contract, which is what the prompt means
			// by "your output contract skill". Attaching it here rather
			// than restating it in the prompt keeps one copy: a contract
			// stated twice drifts, and the copy in the prompt is the one
			// nobody updates.
			extraSkills: [contract],
			// So a finding survives the reviewer that found it. Every
			// other protection here recovers an answer, and an answer
			// only exists if the reviewer reached the end.
			extraExtensions: [
				...(RECORDS_FINDINGS.has(watch.round) ? [journalPack()] : []),
				...fencePacks(),
			],
			env: FENCED,
			// The charter is a standing instruction, and the system prompt
			// says so, but it rides after the round's brief: every
			// participant's request is then the same up to the end of the
			// brief, which the first writes to the cache and the rest read.
			...lensFor(charters.get(participant.id)),
			// Supervised rather than fire-and-forget, so the reviewer
			// leaves a transcript, a stderr log and a resumable session
			// under the round's own directory. The spawn runner kept all
			// of that in memory and dropped it, which is why a round that
			// cost fifty dollars could be investigated only by paying for
			// it again.
			runPi: reviewerRunner(getParentPiInstall(), runArtifactDir()),
			// Names what this reviewer leaves behind after the round that
			// paid for it, so a transcript can be found from the ledger.
			runId: context.runId,
			// Two things, both of which need the session the supervisor
			// persists: a resume after a transient provider drop, and,
			// for a reviewer we stopped, an ask for the findings it had
			// already formed. The second is the one that matters here,
			// since a stop carries no error and so can never reach the
			// first.
			autoResume: true,
			// Cancellable, so Escape on the panel really stops the work
			// rather than only hiding it. The runner kills the child on
			// abort; all that was ever missing was passing the signal down.
			// This participant's own, so cancelling one leaves the rest
			// running. It is derived from the round's, so Escape still
			// reaches every one of them.
			signal: watch.signalFor(participant.id),
			// Bounded twice, and the idle clock is the one doing the work:
			// it catches a participant that has gone silent, while the wall
			// clock only backstops one that nothing else will stop. Bounding
			// on the wall clock alone is what killed six rounds of reviewers
			// that were still working.
			...budget,
			// The one place a subprocess becomes something a person can
			// watch. The library cannot see a stream, so it is told.
			...(context.report === undefined
				? {}
				: {
						onEvent(event) {
							const activity = summarizeStreamActivity(event);
							if (activity !== null) context.report?.(activity);
						},
					}),
		});
		// Counted before it is read, and counted whatever it turns
		// out to say. This is the same publication a fleet makes for
		// each of its subagents, and it is what puts a round in the
		// footer meter and in the run table beside one.
		recordReviewerRun({
			runId: billTo ?? context.runId,
			participantId: participant.id,
			...(participant.model === undefined ? {} : { model: participant.model }),
			// Left unset, the child inherits pi's default, which this
			// process cannot see, so unset records as unknown.
			thinkingLevel: participant.thinkingLevel ?? null,
			startedAt,
			result,
		});
		// Told what it was allowed, so a stop records the clock it ran
		// out of rather than only that one did. A retry cannot
		// otherwise tell whether anything has changed since.
		const answer = answerFromReviewer(result, budget);
		if ("failure" in answer) return answer;
		// Kept before it is read, and kept whatever it turns out to
		// hold. An answer that parses is already represented by its
		// findings; the one worth keeping is the one that does not,
		// and that is exactly the one the old path threw away.
		return {
			...answer,
			answerPath: await keptAt(context.runId, participant.id, answer.text),
		};
	}
}

/**
 * The same dependencies, for a round that is not a new round.
 *
 * A retry runs one participant through the council path to substitute
 * its outcome into a round that already exists. That path now opens a
 * ledger entry before it asks, which is right for a round somebody
 * asked for and wrong here: it would leave a one-participant round on
 * the ledger that nothing ever settles, and an unsettled round is
 * precisely the signal meaning a session died holding one. The retry
 * would manufacture the alarm it is meant to help answer.
 *
 * Both retries, now that the judge writes itself down too. Only the
 * council path was wrapped, which was harmless for exactly as long as
 * the judge ignored the callback, and became a stray round the day it
 * stopped.
 */
function substituting(deps: CouncilDeps): Omit<CouncilDeps, "opened"> {
	// Typed against CouncilDeps rather than a structural constraint.
	// `T extends { opened?: unknown }` was satisfied by every object
	// type, so renaming the callback would have left this returning
	// its argument untouched and quietly restored the stray round,
	// with nothing to report it. Named concretely, the same rename is
	// a compile error here.
	const { opened: _discarded, ...rest } = deps;
	return rest;
}

/**
 * What the council a judge consolidated raised, for that judge being
 * asked again: the one it recorded, or the latest for a judge recorded
 * before it said.
 *
 * A retried judge has to see the same material it saw the first time,
 * or it is answering a different question and its substituted outcome
 * would not be comparable to the one it replaced.
 */
async function councilFindingsBehind(
	change: ChangeRef,
	store: RunStore,
	basis: string | undefined,
): Promise<Finding[]> {
	const chosen = await roundToRead(store, change, "council", basis);
	return "run" in chosen ? await findingsOf(change, chosen.run) : [];
}

/** The findings one round raised, in the order it raised them. */
async function findingsOf(change: ChangeRef, run: AskRun): Promise<Finding[]> {
	const all = await createFindingStore(findingDir()).list(change);
	const wanted = new Set(run.outcomes.flatMap((o) => o.findingIds));
	return all.filter((finding) => wanted.has(finding.id));
}

/** Findings as a judge reads them, attribution and all. */
function renderFindings(findings: Finding[]): string {
	return findings
		.map((finding) => {
			const who =
				finding.origin.kind === "hand" ? "hand" : finding.origin.reviewerId;
			const where =
				finding.anchor.subject === "change"
					? "the change as a whole"
					: finding.anchor.subject === "file"
						? finding.anchor.path
						: `${finding.anchor.path}:${finding.anchor.line}`;
			return [
				`[F${finding.id}] ${who} · ${finding.label} · ${where}`,
				finding.subject,
				finding.discussion,
			].join("\n");
		})
		.join("\n\n");
}
