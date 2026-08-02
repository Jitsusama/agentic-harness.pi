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
	type AskRound,
	type AskRun,
	auditPrompt,
	bindPersonas,
	type ChangeRef,
	type Critique,
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
	substituteOutcome,
	type Thread,
	type ThreadAudit,
} from "../../../lib/review/index.js";
import type { ReviewerThinkingLevel } from "../../../lib/subagent/index.js";
import {
	createSpawnRunPi,
	getParentPiInstall,
	runReviewer,
	summarizeStreamActivity,
} from "../../../lib/subagent/index.js";
import { count } from "../../../lib/ui/count.js";
import { REVIEW_SLUG } from "../config.js";
import { findingDir, personaDir, reviewEngine, runDir } from "../engine.js";
import {
	PARTICIPANT_TIMEOUT_MS,
	type RoundWatch,
	watchRound,
} from "../progress.js";
import { GLYPH } from "../render.js";
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
	| "judge"
	| "critique"
	| "audit"
	| "stack"
	| "runs"
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
						Type.Literal("runs"),
						Type.Literal("retry"),
						Type.Literal("release"),
					],
					{
						description:
							"What to do. council: ask every reviewer on the roster, independently and at once. judge: ask the roster's judge to consolidate the latest council. critique: ask the roster to push back on what the judge concluded, recording positions rather than findings. audit: judge each unresolved inbound thread against the change, so a reply is informed rather than guessed. stack: put every change in the stack to the roster together, so a finding that only exists between changes can be seen. runs: what rounds have been asked about this change. retry: ask one participant again and substitute their outcome in place. release: free a participant id so it can mean a different model, which is the way out the identity refusal names. Defaults to runs, which changes nothing.",
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
				const watch = (round: AskRound): RoundWatch =>
					watchRound(round, ctx, signal);

				switch (action) {
					case "runs":
						return await reportRuns(change);
					case "council":
						return await askCouncil(bound, change, params, watch("council"));
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

	await createRunStore(runDir()).record(change, run);
	return say(answerFor(run, warnings, tree.caveat), { run, warnings });
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
		return refuse(
			`No council has been asked about ${change.label}, so there is nothing to consolidate. Run a council first.`,
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
					deps(change, tree.path, watch, charters),
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
	return {
		async ask(
			participant: Participant,
			prompt: string,
			report?: (activity: string) => void,
		): Promise<AskAnswer> {
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
				// The charter is a standing instruction, so it goes as the
				// system prompt rather than being glued onto the front of the
				// round's prompt: a lens is what the reviewer is, not part of
				// what it was asked this time.
				...(charters.get(participant.id) === undefined
					? {}
					: { systemPrompt: charters.get(participant.id) }),
				runPi: createSpawnRunPi({ piInstall: getParentPiInstall() }),
				// Cancellable, so Escape on the panel really stops the work
				// rather than only hiding it. The runner kills the child on
				// abort; all that was ever missing was passing the signal down.
				// This participant's own, so cancelling one leaves the rest
				// running. It is derived from the round's, so Escape still
				// reaches every one of them.
				signal: watch.signalFor(participant.id),
				// Still bounded, for a participant that stops responding while
				// nobody is watching the panel.
				timeoutMs: PARTICIPANT_TIMEOUT_MS,
				// The one place a subprocess becomes something a person can
				// watch. The library cannot see a stream, so it is told.
				...(report === undefined
					? {}
					: {
							onEvent(event) {
								const activity = summarizeStreamActivity(event);
								if (activity !== null) report(activity);
							},
						}),
			});
			if (result.exitCode !== 0 && result.finalAssistantText.trim() === "") {
				const said = result.error?.message ?? result.stderr.trim();
				return {
					failure:
						said === "" || said === undefined
							? `${participant.id} exited ${result.exitCode} without answering.`
							: said,
				};
			}
			return {
				text: result.finalAssistantText,
				...(result.usage === undefined
					? {}
					: {
							usage: {
								tokens: result.usage.tokens.total,
								cost: result.usage.cost.total,
							},
						}),
			};
		},
		record(raised: Omit<Finding, "id">[]) {
			return findings.record(change, raised);
		},
		now: () => new Date(),
		// Every round reports. A round that fans out and says nothing for
		// minutes is indistinguishable from one that has hung, which is
		// the whole reason this exists.
		progress: watch.progress,
	};
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
	return `${run.id}: ${summary.answered}/${summary.asked} answered${failed}, ${count(summary.findings, "finding")}`;
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
