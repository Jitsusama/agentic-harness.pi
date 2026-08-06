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

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	type ConfigLoadResult,
	loadPackageConfig,
} from "../../../lib/internal/config/loader.js";
import { packageConfigPath } from "../../../lib/internal/paths.js";
import {
	type AskAnswer,
	type AskContext,
	type AskRound,
	type AskRun,
	auditPrompt,
	bindPersonas,
	type ChangeRef,
	type CouncilDeps,
	type Critique,
	collectRound,
	councilPrompt,
	createFindingStore,
	createIdentityLedger,
	createRunStore,
	critiquePrompt,
	describeAnchor,
	type Finding,
	judgePrompt,
	type Participant,
	parsePersona,
	parseRoster,
	type Roster,
	type RunStore,
	runAudit,
	runCouncil,
	runCritique,
	runJudge,
	runStackCouncil,
	runSummary,
	stackPrompt,
	startCouncil,
	stoppedNotes,
	substituteOutcome,
	type Thread,
	type ThreadAudit,
} from "../../../lib/review/index.js";
import type { ReviewerThinkingLevel } from "../../../lib/subagent/index.js";
import {
	getParentPiInstall,
	ReviewerArtifactsStore,
	runReviewer,
	startReviewer,
	summarizeStreamActivity,
} from "../../../lib/subagent/index.js";
import { count } from "../../../lib/ui/count.js";
import {
	type ReviewerBudget,
	retryWouldRepeat,
	reviewerBudget,
} from "../budget.js";
import { REVIEW_SLUG } from "../config.js";
import {
	answerDir,
	findingDir,
	personaDir,
	reviewEngine,
	runArtifactDir,
	runDir,
} from "../engine.js";
import { type RoundWatch, watchRound } from "../progress.js";
import { GLYPH } from "../render.js";
import {
	answerFromReviewer,
	answerLeftBehind,
	keepAnswer,
	reviewerRunner,
	reviewerStarter,
} from "../reviewer.js";
import { treeForRound } from "../work.js";
import {
	type Answer,
	boundFor,
	hostedChange,
	messageOf,
	refuse,
	renderAnswer,
	renderInvocation,
	say,
	type TargetParams,
} from "./shared.js";

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

interface AskParams extends TargetParams {
	action?: AskAction;
	intent?: string;
	participant?: string;
	run?: string;
}

/** Register the `review_ask` tool. */
export function registerAskTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_ask",
		label: "Review Ask",
		description:
			"Put a change to other models and keep what they say: a council of reviewers reading it independently, a judge consolidating what they found, the rounds already run, and a retry of one participant whose run failed. Produces findings; read them with review_see findings and decide them with review_draft decide.",
		promptSnippet:
			"Ask other models about a change: a council, a judge over it, the rounds so far, or a retry of one participant.",
		promptGuidelines: [
			"The roster comes from config, not from the call. A refusal names the path in the config file that is wrong.",
			"A council is the discovery pass and a judge consolidates it, so run a council first; a judge with no council to read is refused rather than asked to invent one.",
			"An id that has raised findings is held to the model, thinking level, tools and persona it meant. Reconfiguring one is refused, and the refusal names both ways out: another id, or release this one and accept that its findings no longer identify who raised them.",
			"A round reads a snapshot pinned to the commit under review. When it cannot, the answer carries a caveat saying which tree was read instead: pass that on, because a round against the wrong tree still returns plausible findings.",
			"Reading findings is review_see findings and deciding them is review_draft decide. This tool only produces them.",
		],
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("council"),
						Type.Literal("judge"),
						Type.Literal("critique"),
						Type.Literal("audit"),
						Type.Literal("stack"),
						Type.Literal("start"),
						Type.Literal("stop"),
						Type.Literal("runs"),
						Type.Literal("collect"),
						Type.Literal("retry"),
						Type.Literal("release"),
					],
					{
						description:
							"What to do. council: ask every reviewer on the roster, independently and at once, waiting for all of them. start: the same round, dispatched and left running, so the session is free straight away; nothing is watching it, so there is no progress, no wrap-up and no retry, and you finish it later with collect. stop: ask every reviewer in a started round to stop, which is the only way to end one early since nothing is holding it; what they wrote down is kept and collect still works. judge: ask the roster's judge to consolidate the latest council. critique: ask the roster to push back on what the judge concluded, recording positions rather than findings. audit: judge each unresolved inbound thread against the change, so a reply is informed rather than guessed. stack: put every change in the stack to the roster together, so a finding that only exists between changes can be seen. runs: what rounds have been asked about this change. collect: finish a round whose session ended before it could, reading what its reviewers left on disk, which is what an unsettled round in the listing is telling you to do. retry: ask one participant again and substitute their outcome in place. release: free a participant id so it can mean a different model, which is the way out the identity refusal names. Defaults to runs, which changes nothing.",
					},
				),
			),
			change: Type.Optional(
				Type.String({
					description:
						"Reference to a hosted change: URL, short form or number. Omit to use the attached change.",
				}),
			),
			repo: Type.Optional(
				Type.String({ description: "Checkout path, for a local review." }),
			),
			intent: Type.Optional(
				Type.String({
					description:
						"Extra direction for this round only, e.g. 'look hardest at the error paths'. Not persisted: the standing lens belongs in a participant's persona.",
				}),
			),
			participant: Type.Optional(
				Type.String({
					description: "Which participant to ask again. Required for retry.",
				}),
			),
			run: Type.Optional(
				Type.String({
					description:
						"Which round to retry into. Defaults to the latest council.",
				}),
			),
		}),

		renderCall(
			args: unknown,
			theme: Theme,
			context?: { lastComponent?: unknown },
		): Text {
			const params = args as AskParams;
			return renderInvocation(
				theme,
				"review_ask",
				params.action ?? "runs",
				params.participant ?? params.change,
				context?.lastComponent,
			);
		},

		renderResult(
			result: Answer,
			options: { expanded?: boolean },
			theme: Theme,
			context?: { lastComponent?: unknown },
		): Text {
			return renderAnswer(result, theme, options, context?.lastComponent);
		},

		// Pi passes (toolCallId, params, signal, onUpdate, ctx). Reading the
		// first as the payload was a real bug: the id is a string, so every
		// field came back undefined and no council could ever run, because
		// every action arrived as `runs`. The signal and the context were lost
		// the same way, and three comments in this extension claimed pi
		// provided neither.
		async execute(
			_toolCallId: string,
			args: unknown,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<Answer> {
			const params = args as AskParams;
			const action = params.action ?? "runs";
			const opened: RoundWatch[] = [];
			try {
				const bound = await boundFor(pi, params, process.cwd());
				const change = hostedChange(bound);
				if (change === undefined) {
					return refuse(
						"Nothing hosts this target, so there is no change to ask about. Asking models to review a local range is worth doing and is not wired yet.",
					);
				}

				// One watch per call rather than one per round helper, so the
				// panel and the signal are the same objects everything sees.
				//
				// Kept, so the finally below can settle whatever was opened.
				// Every round ends by telling its progress it has finished,
				// which is what takes the panel down, and none of them do it
				// from a finally: a round that threw left the editor
				// replaced and, once the panel grew a clock, a timer
				// repainting it once a second for the rest of the session.
				// Settling twice is harmless; not settling at all is not.
				const watch = (round: AskRound): RoundWatch => {
					const made = watchRound(round, ctx, signal);
					opened.push(made);
					return made;
				};

				switch (action) {
					case "runs":
						return await reportRuns(change);
					case "collect":
						return await collectOne(change, params);
					case "council":
						return await askCouncil(bound, change, params, watch("council"));
					case "start":
						return await startRound(bound, change, params);
					case "stop":
						return await stopRound(change, params);
					case "judge":
						return await askJudge(bound, change, params, watch("judge"));
					case "critique":
						return await askCritique(bound, change, params, watch("critique"));
					case "audit":
						return await askAudit(bound, change, params, watch("audit"));
					case "stack":
						return await askStack(pi, bound, params, watch("stack"));
					case "retry":
						return await retryOne(bound, change, params, watch("council"));
					case "release":
						return releaseIdentity(params);
				}
			} catch (error) {
				return refuse(messageOf(error));
			} finally {
				for (const made of opened) made.progress.finish();
			}
		},
	});
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
async function stopRound(
	change: ChangeRef,
	params: AskParams,
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

	await new ReviewerArtifactsStore(runArtifactDir()).requestRunCancellation(
		held.id,
		`Stopped from a session on ${new Date().toISOString()}.`,
	);

	return say(
		[
			`Asked every reviewer in ${held.id} to stop.`,
			`They notice within a second or so and are killed if they do not. Collect it once they are gone: what they wrote down before stopping is kept.`,
		].join("\n"),
		{ run: held },
	);
}

/**
 * Finish a round whose session ended before it could.
 *
 * Everything the reviewers produced is already on disk, and until now
 * the only thing that could turn it into findings was the session that
 * died. This asks nobody and spends nothing: it reads what is there,
 * files it the way the round would have, and settles the round.
 */
async function collectOne(
	change: ChangeRef,
	params: AskParams,
): Promise<Answer> {
	const store = createRunStore(runDir());
	const unsettled = (await store.list(change)).filter(
		(run) => run.open === true,
	);
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
	const alive = await stillRunning(artifacts, held);
	if (alive !== undefined) return refuse(alive);

	const answers = new Map<string, AskAnswer>();
	const unreadable: string[] = [];
	for (const participant of held.participants) {
		// No budget. On the live path the same config call configured
		// the run, so stamping it on a stop is history. Here the round
		// ran hours or days ago, possibly under different numbers, and
		// writing today's into the stop would record a limit the run
		// never hit and then refuse the retry that raising it was for.
		const left = await answerLeftBehind(artifacts, held.id, participant.id);
		if (left.kind === "answer") answers.set(participant.id, left.answer);
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
		].join("\n"),
		{ run, warnings },
	);
}

/**
 * Why this round must not be collected yet, when a supervisor still
 * holds it.
 *
 * An open mark says a round started and did not finish, which is the
 * same on the ledger for a dead session and for a council running
 * right now in another window. Collecting a live round reads the
 * reviewers that have finished, files their findings, records the rest
 * as having left nothing, and settles it. The session still running
 * then finishes and records the whole round again: every early finding
 * filed twice, and a settled round that says its reviewers found
 * nothing.
 *
 * The lease is the answer, and it is the same one startup recovery
 * uses: a reviewer directory holds the pid of the supervisor that owns
 * it.
 */
async function stillRunning(
	artifacts: ReviewerArtifactsStore,
	held: AskRun,
): Promise<string | undefined> {
	for (const participant of held.participants) {
		const { leasePath } = artifacts.paths(held.id, participant.id);
		const lease = await artifacts
			.readJson<{ supervisorPid?: number | null }>(leasePath)
			.catch(() => null);
		const pid = lease?.supervisorPid;
		if (typeof pid !== "number" || !alive(pid)) continue;
		return `${held.id} is still being run: ${participant.id} is held by a supervisor (pid ${pid}) that is alive. Collecting now would file the findings of whoever has finished and then let that session file them again. Wait for it, or collect once it is gone.`;
	}
	return undefined;
}

/** Whether a process is still there to own something. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// No such process, or one we may not signal. Either way it is
		// not this session's supervisor holding the round.
		return false;
	}
}

/** Ask every reviewer on the roster. */
async function askCouncil(
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
	watch: RoundWatch,
): Promise<Answer> {
	const roster = await rosterOrThrow();
	const charters = await chartersFor(roster);
	await claimIdentities(change, "reviewer", roster.reviewers);
	const { proposal, diff } = await material(bound);
	const prompt = councilPrompt({
		proposal,
		diff,
		...(params.intent === undefined ? {} : { intent: params.intent }),
	});
	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		process.cwd(),
	);

	const { run, warnings } = await runCouncil(
		{
			roster,
			prompt,
			seq: 1,
			...(proposal.headCommit === undefined
				? {}
				: { witness: proposal.headCommit }),
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
	return say(answerFor(run, [...warnings, ...kept], tree.caveat), {
		run,
		warnings,
	});
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
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
): Promise<Answer> {
	const roster = await rosterOrThrow();
	const charters = await chartersFor(roster);
	await claimIdentities(change, "reviewer", roster.reviewers);
	const { proposal, diff } = await material(bound);
	const prompt = councilPrompt({
		proposal,
		diff,
		...(params.intent === undefined ? {} : { intent: params.intent }),
	});
	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		process.cwd(),
	);
	const budget = await budgetForRound();
	const starter = reviewerStarter(getParentPiInstall(), runArtifactDir());
	const store = createRunStore(runDir());
	const contract = contractSkill("council");

	const { run, warnings } = await startCouncil(
		{
			roster,
			prompt,
			seq: 1,
			...(proposal.headCommit === undefined
				? {}
				: { witness: proposal.headCommit }),
		},
		{
			now: () => new Date(),
			// Unguarded, unlike the council's. There the entry is
			// bookkeeping and the findings survive without it; here it is
			// the only thing that will ever say these seven directories
			// were a round, so failing to write it has to stop the round
			// rather than cost it later.
			opened: (opening) => store.keep(change, opening),
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
					extraSkills: [contract],
					// Not optional here the way it is on the waiting path.
					// A detached reviewer's answer is only ever read off
					// disk, so a finding it did not write down before it
					// died is a finding nothing can recover.
					extraExtensions: [journalPack()],
					...(charters.get(participant.id) === undefined
						? {}
						: { systemPrompt: charters.get(participant.id) }),
					runId,
					stateDir: runArtifactDir(),
					startPi: starter,
					...budget,
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

	const running = run.participants.length - warnings.length;
	return say(
		[
			running === 0
				? `Started nothing for ${run.id}, so there is nothing to collect.`
				: `Started ${run.id}: ${count(running, "reviewer")} running, nothing waiting for them.`,
			...(running === 0
				? []
				: [
						`Finish it with review_ask collect once they are done. Until then it reads as opened and never settled, which is what it is.`,
					]),
			...warnings.map((warning) => `${GLYPH.refused} ${warning}`),
			...kept,
			...(tree.caveat === undefined ? [] : [tree.caveat]),
		].join("\n"),
		{ run, warnings },
	);
}

/** Ask the judge to consolidate the latest council. */
async function askJudge(
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
	watch: RoundWatch,
): Promise<Answer> {
	const roster = await rosterOrThrow();
	const charters = await chartersFor(roster);
	if (roster.judge === undefined) {
		return refuse(
			"This roster names no judge, so there is nobody to consolidate with. Add a judge to the config, with an id of its own: a judge reads what the reviewers said, so it cannot share a reviewer's name.",
		);
	}

	const store = createRunStore(runDir());
	const council = await store.latest(change, "council");
	if (council === undefined) {
		// A started round is on the ledger and unfinished, and `latest`
		// only returns finished ones, so without this the answer to "a
		// council is running, judge it" is "run a council": the one
		// instruction that costs another roster and still will not work.
		const open = (await store.list(change)).filter((run) => run.open === true);
		return refuse(
			open.length === 0
				? `No council has been asked about ${change.label}, so there is nothing to consolidate. Run a council first.`
				: `${count(open.length, "round")} on ${change.label} has been started and not collected, so there is nothing consolidated to judge yet: ${open.map((run) => run.id).join(", ")}. Collect it first.`,
		);
	}

	await claimIdentities(change, "judge", [roster.judge]);
	const raised = await findingsOf(change, council);
	const { proposal, diff } = await material(bound);
	const prompt = judgePrompt({
		proposal,
		diff,
		findings: renderFindings(raised),
		...(params.intent === undefined ? {} : { intent: params.intent }),
	});

	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		process.cwd(),
	);
	const { run, warnings } = await runJudge(
		{
			judge: roster.judge,
			prompt,
			seq: 1,
			...(proposal.headCommit === undefined
				? {}
				: { witness: proposal.headCommit }),
		},
		deps(change, tree.path, watch, charters),
	);

	await store.record(change, run);
	return say(answerFor(run, warnings, tree.caveat), { run, warnings });
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
	watch: RoundWatch,
): Promise<Answer> {
	const roster = await rosterOrThrow();
	const charters = await chartersFor(roster);
	await claimIdentities(change, "reviewer", roster.reviewers);

	const store = createRunStore(runDir());
	const judged = await store.latest(change, "judge");
	if (judged === undefined) {
		return refuse(
			`No judge has consolidated anything on ${change.label}, so there is nothing settled enough to push back on. Run a council, then a judge.`,
		);
	}

	const raised = await findingsOf(change, judged);
	const { proposal, diff } = await material(bound);
	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		process.cwd(),
	);

	const { run, critiques, warnings } = await runCritique(
		{
			roster,
			prompt: critiquePrompt({
				proposal,
				diff,
				findings: renderFindings(raised),
				...(params.intent === undefined ? {} : { intent: params.intent }),
			}),
			seq: 1,
			findingIds: raised.map((finding) => finding.id),
		},
		{
			ask: deps(change, tree.path, watch, charters).ask,
			now: () => new Date(),
			progress: watch.progress,
		},
	);

	await store.record(change, run);
	return say(
		[
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
	watch: RoundWatch,
): Promise<Answer> {
	const roster = await rosterOrThrow();
	const charters = await chartersFor(roster);

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
		node.proposal === undefined
			? []
			: [{ ref: node.ref, proposal: node.proposal }],
	);
	if (proposed.length === 0) {
		return refuse(
			"No change in this stack has a proposal on it, so there is nothing to read. A stack of branches nobody has proposed is still a stack, but it carries no bodies or diffs to review.",
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
		process.cwd(),
	);

	const stackRefs = changes.map((one) => one.ref);
	const witnesses = new Map(
		changes.map((one) => [one.ref, one.proposal.headCommit]),
	);
	const changeFor = new Map(changes.map((one) => [one.ref, one.change]));
	const findings = createFindingStore(findingDir());

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
			}),
			seq: 1,
			stackRefs,
			witnessFor: (ref) => witnesses.get(ref),
		},
		{
			ask: deps(tip.change, tree.path, watch, charters).ask,
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
	watch: RoundWatch,
): Promise<Answer> {
	const roster = await rosterOrThrow();
	const charters = await chartersFor(roster);
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

	if (!bound.conversation) {
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
		process.cwd(),
	);

	// Indices are the ones a person cites, meaning the position in the
	// full thread listing rather than among the unresolved ones. An
	// audit that renumbered them would send somebody to the wrong
	// thread, which is the same harm the elsewhere standing exists to
	// avoid.
	const indexOf = new Map(threads.map((thread, at) => [thread.id, at + 1]));
	const threadIndices = open.flatMap((thread) => {
		const at = indexOf.get(thread.id);
		return at === undefined ? [] : [at];
	});

	const { run, audits, warnings } = await runAudit(
		{
			auditor,
			prompt: auditPrompt({
				proposal,
				diff,
				threads: renderThreads(open, indexOf),
				...(params.intent === undefined ? {} : { intent: params.intent }),
			}),
			seq: 1,
			threadIndices,
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

	const asked = held.participants.find((p) => p.id === params.participant);
	if (asked === undefined) {
		return refuse(
			`Round ${held.id} never asked "${params.participant}". It asked ${held.participants.map((p) => p.id).join(", ")}.`,
		);
	}

	// A stopped reviewer is not a failed one, and asking it again while
	// the clock that stopped it has not moved spends the same money to
	// meet the same wall. Refused rather than warned about: the whole
	// point is that the outcome is known in advance.
	const before = held.outcomes.find((o) => o.participantId === asked.id);
	const repeats = retryWouldRepeat(before?.stopped, await budgetForRound());
	if (repeats !== undefined) return refuse(repeats);

	const roster = await rosterOrThrow();
	const charters = await chartersFor(roster);
	const participant =
		roster.reviewers.find((r) => r.id === asked.id) ??
		(roster.judge?.id === asked.id ? roster.judge : undefined);
	if (participant === undefined) {
		return refuse(
			`The roster no longer names "${asked.id}", so it cannot be asked again. Re-add it to the config, or run a fresh round.`,
		);
	}

	await claimIdentities(change, asked.role, [participant]);
	const { proposal, diff } = await material(bound);
	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		process.cwd(),
	);
	const witness =
		proposal.headCommit === undefined ? {} : { witness: proposal.headCommit };
	const intent = params.intent === undefined ? {} : { intent: params.intent };

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
								await councilFindingsBehind(change, store),
							),
							...intent,
						}),
						seq: 1,
						...witness,
					},
					deps(change, tree.path, watch, charters),
				)
			: await runCouncil(
					{
						roster: { reviewers: [participant] } satisfies Roster,
						prompt: councilPrompt({ proposal, diff, ...intent }),
						seq: 1,
						...witness,
					},
					substituting(deps(change, tree.path, watch, charters)),
				);

	const outcome = fresh.outcomes[0];
	if (outcome === undefined) {
		return refuse(`Asking "${asked.id}" again produced no outcome at all.`);
	}

	const updated = substituteOutcome(held, outcome);
	await store.replace(change, updated);
	return say(
		[
			`${GLYPH.finding} Asked ${asked.id} again in ${held.id}.`,
			describeRun(updated),
			...warnings,
			...(tree.caveat === undefined ? [] : [tree.caveat]),
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

/**
 * The roster from config, or a refusal explaining what is wrong.
 *
 * Read from the package config file rather than passed in, which is
 * the whole point: a roster is a standing choice about who reviews,
 * not something to retype per call.
 */
async function rosterOrThrow(): Promise<Roster> {
	const path = packageConfigPath();
	return rosterFromConfig(await loadPackageConfig(path), path);
}

/**
 * What bounds this round's reviewers, as configured.
 *
 * Read from the same section the roster comes from, because who is
 * asked and how long they get are one decision about one fan-out.
 * Falls back to the defaults for any config that cannot be read: a
 * round is better bounded generously than refused over a budget.
 */
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

async function budgetForRound(): Promise<ReviewerBudget> {
	const loaded = await loadPackageConfig(packageConfigPath());
	if (!loaded.ok) return reviewerBudget(undefined);
	const review = loaded.config.sections[REVIEW_SLUG];
	return reviewerBudget(isRecord(review) ? review.ask : undefined);
}

/**
 * The roster held in a loaded config, or a throw saying why not.
 *
 * Separated from the loading so the lookup can be tested against a
 * file on disk. It reads `sections.review.ask`, which is where every
 * extension's settings live: reading one level higher finds nothing
 * for every well-formed config there is, and the refusal that follows
 * blames the config rather than the lookup.
 */
export async function rosterFromConfig(
	loaded: ConfigLoadResult,
	path: string,
): Promise<Roster> {
	if (!loaded.ok) {
		throw new Error(
			`The config at ${loaded.path} could not be read, so there is no roster to ask: ${loaded.error}`,
		);
	}
	const review = loaded.config.sections[REVIEW_SLUG];
	const section = isRecord(review) ? review.ask : undefined;
	if (section === undefined) {
		throw new Error(
			`No roster is configured, so there is nobody to ask. Add a review.ask section to ${path} with a reviewers array, and optionally a judge with an id of its own.`,
		);
	}
	const parsed = parseRoster(section);
	if ("refusal" in parsed) throw new Error(parsed.refusal);
	return parsed.roster;
}

/** Whether a value is an object we can read keys off. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	return join(here, "..", "..", "..", "packs", "review-journal", "index.ts");
}

/**
 * Every charter on disk, by persona id.
 *
 * Read once per round rather than per participant, since six reviewers
 * naming three personas should not be six directory walks. A file that
 * will not parse stops the round: a roster naming it would otherwise
 * fail with "no such persona" while the file sits right there, which
 * sends somebody looking in the wrong place.
 */
async function chartersOnDisk(): Promise<Map<string, string>> {
	const dir = personaDir();
	const charters = new Map<string, string>();

	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		// No persona directory at all is the ordinary case for anybody who
		// has never written one, and a roster naming no persona never
		// asks. bindPersonas refuses if one is named.
		return charters;
	}

	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		const id = basename(name, ".md");
		const parsed = parsePersona(id, await readFile(join(dir, name), "utf8"));
		if ("refusal" in parsed) throw new Error(parsed.refusal);
		charters.set(id, parsed.persona.charter);
	}
	return charters;
}

/**
 * Each participant's charter, by participant id.
 *
 * Keyed by participant rather than by persona, because a round asks by
 * participant id and the same lens can be on a roster twice at two
 * thinking levels. A missing persona stops the round here, before
 * anybody is asked, since a reviewer running without its lens files
 * generic findings under a specialist's name.
 */
async function chartersFor(roster: Roster): Promise<Map<string, string>> {
	const onDisk = await chartersOnDisk();
	const bound = bindPersonas(roster, (id) => onDisk.get(id));
	if ("refusal" in bound) throw new Error(bound.refusal);

	const byParticipant = new Map<string, string>();
	for (const binding of bound.bindings) {
		if (binding.charter !== undefined) {
			byParticipant.set(binding.participant.id, binding.charter);
		}
	}
	return byParticipant;
}

/** The change and its diff, which every round needs. */
async function material(bound: Awaited<ReturnType<typeof boundFor>>) {
	const [proposal, diff] = await Promise.all([
		bound.proposal(),
		bound.diffModel(),
	]);
	if (proposal === null) {
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
) {
	const findings = createFindingStore(findingDir());
	// The watch knows which round this is, so it is not passed twice.
	const contract = contractSkill(watch.round);
	// Read once for the round rather than once per participant, and
	// started here rather than awaited, so seven reviewers share one
	// config read without any of them waiting on it to be asked.
	const bounds = budgetForRound();
	return {
		async ask(
			participant: Participant,
			prompt: string,
			context: AskContext,
		): Promise<AskAnswer> {
			const budget = await bounds;
			const result = await runReviewer({
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
				prompt,
				cwd,
				// The round's output contract, which is what the prompt means
				// by "your output contract skill". Attaching it here rather
				// than restating it in the prompt keeps one copy: a contract
				// stated twice drifts, and the copy in the prompt is the one
				// nobody updates.
				extraSkills: [contract],
				// So a finding survives the reviewer that found it. Every
				// other protection here recovers an answer, and an answer
				// only exists if the reviewer reached the end.
				...(RECORDS_FINDINGS.has(watch.round)
					? { extraExtensions: [journalPack()] }
					: {}),
				// The charter is a standing instruction, so it goes as the
				// system prompt rather than being glued onto the front of the
				// round's prompt: a lens is what the reviewer is, not part of
				// what it was asked this time.
				...(charters.get(participant.id) === undefined
					? {}
					: { systemPrompt: charters.get(participant.id) }),
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
		},
		record(raised: Omit<Finding, "id">[]) {
			return findings.record(change, raised);
		},
		now: () => new Date(),
		// Written down before the first reviewer is dispatched, so the
		// most expensive thing this tool does stops being the one thing
		// nothing records until it is over. Recorded rather than
		// replaced, since at this point the round is new.
		async opened(run: AskRun) {
			try {
				await createRunStore(runDir()).keep(change, run);
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
}

/**
 * The same dependencies, for a round that is not a new round.
 *
 * A retry runs one participant through the council path to substitute
 * its outcome into a round that already exists. That path now opens a
 * ledger entry before it asks, which is right for a council and wrong
 * here: it would leave a one-participant round on the ledger that
 * nothing ever settles, and an unsettled round is precisely the signal
 * meaning a session died holding one. The retry would manufacture the
 * alarm it is meant to help answer.
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
 * Put a finished round on the ledger, saying so if it could not be.
 *
 * Never throws. The round has already happened and its findings are
 * already recorded against the change; failing to write the ledger
 * entry loses the index, not the work, and answering with a refusal
 * would hide fifteen minutes of review behind a filesystem error.
 */
async function keptOnLedger(change: ChangeRef, run: AskRun): Promise<string[]> {
	try {
		await createRunStore(runDir()).keep(change, run);
		return [];
	} catch (error) {
		return [
			`${GLYPH.refused} This round is not on the ledger (${messageOf(error)}), so a judge or a retry will not find it by id. Its findings are recorded against the change regardless.`,
		];
	}
}

/**
 * What the latest council raised, for a judge being asked again.
 *
 * A retried judge has to see the same material it saw the first time,
 * or it is answering a different question and its substituted outcome
 * would not be comparable to the one it replaced.
 */
async function councilFindingsBehind(
	change: ChangeRef,
	store: RunStore,
): Promise<Finding[]> {
	const council = await store.latest(change, "council");
	return council === undefined ? [] : await findingsOf(change, council);
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

/** One round, in a line. */
function describeRun(run: AskRun): string {
	const summary = runSummary(run);
	const failed = summary.failed > 0 ? `, ${summary.failed} failed` : "";
	// Only a council carries this, and only while it is unsettled, so
	// the sentence says what is actually known: it opened and nothing
	// closed it. Whether that is a dead session or a round still
	// running in another window is not ours to assert, and the useful
	// half is the same either way, since the reviewers' answers are on
	// disk under this id.
	const abandoned = run.open === true ? ", opened and never settled" : "";
	const head = `${run.id}: ${summary.answered}/${summary.asked} answered${failed}, ${count(summary.findings, "finding")}${abandoned}`;
	// A stopped reviewer's answer was being recorded and never shown,
	// which is most of the way to losing it: the path is only useful to
	// somebody who knows to look for it.
	return [head, ...stoppedNotes(run).map((note) => `  ${note}`)].join("\n");
}

/** What a round's answer says. */
function answerFor(run: AskRun, warnings: string[], caveat?: string): string {
	const summary = runSummary(run);
	const lines = [describeRun(run)];
	// Before the findings, not after: a caveat about which tree was
	// read changes how everything below it should be weighed.
	if (caveat !== undefined) lines.push(`${GLYPH.refused} ${caveat}`);
	if (summary.answered === 0) {
		lines.push(
			"Nobody answered, so nothing was recorded. The failures above are the whole story.",
		);
	}
	for (const outcome of run.outcomes) {
		if (outcome.failure !== undefined) {
			// GLYPH.failed, not GLYPH.refused, and the same mark the live panel draws
			// against the same line. A participant whose run broke did not refuse
			// anything, and watching one fail with one mark and then reading the
			// identical fact under another invites the question of whether two things
			// happened to it.
			lines.push(
				`${GLYPH.failed} ${outcome.participantId}: ${outcome.failure}`,
			);
		}
	}
	lines.push(...warnings);
	return lines.join("\n");
}
