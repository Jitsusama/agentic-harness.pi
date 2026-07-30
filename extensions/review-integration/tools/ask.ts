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

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { loadPackageConfig } from "../../../lib/internal/config/loader.js";
import {
	type AskAnswer,
	type AskRun,
	type ChangeRef,
	councilPrompt,
	createFindingStore,
	createRunStore,
	type Finding,
	judgePrompt,
	type Participant,
	parseRoster,
	type Roster,
	runCouncil,
	runJudge,
	runSummary,
	substituteOutcome,
} from "../../../lib/review/index.js";
import type { ReviewerThinkingLevel } from "../../../lib/subagent/index.js";
import {
	createSpawnRunPi,
	getParentPiInstall,
	runReviewer,
} from "../../../lib/subagent/index.js";
import { findingDir, runDir } from "../engine.js";
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
type AskAction = "council" | "judge" | "runs" | "retry";

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
			"Participants run in the session's working directory, so a change that is not checked out there gets reviewed against the wrong tree. Say so rather than letting the caller trust the result.",
			"Reading findings is review_see findings and deciding them is review_draft decide. This tool only produces them.",
		],
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("council"),
						Type.Literal("judge"),
						Type.Literal("runs"),
						Type.Literal("retry"),
					],
					{
						description:
							"What to do. council: ask every reviewer on the roster, independently and at once. judge: ask the roster's judge to consolidate the latest council. runs: what rounds have been asked about this change. retry: ask one participant again and substitute their outcome in place. Defaults to runs, which changes nothing.",
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

		renderCall(args: unknown, theme: Theme): Text {
			const params = args as AskParams;
			return renderInvocation(
				theme,
				"review_ask",
				params.action ?? "runs",
				params.participant ?? params.change,
			);
		},

		renderResult(result: Answer, _state: unknown, theme: Theme): Text {
			return renderAnswer(result, theme);
		},

		async execute(args: unknown): Promise<Answer> {
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

				switch (action) {
					case "runs":
						return await reportRuns(change);
					case "council":
						return await askCouncil(bound, change, params);
					case "judge":
						return await askJudge(bound, change, params);
					case "retry":
						return await retryOne(bound, change, params);
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
		[`${runs.length} round(s) on ${change.label}:`, ...lines].join("\n"),
		{ runs },
	);
}

/** Ask every reviewer on the roster. */
async function askCouncil(
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
): Promise<Answer> {
	const roster = await rosterOrThrow();
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
		deps(change, tree.path),
	);

	await createRunStore(runDir()).record(change, run);
	return say(answerFor(run, warnings, tree.caveat), { run, warnings });
}

/** Ask the judge to consolidate the latest council. */
async function askJudge(
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
): Promise<Answer> {
	const roster = await rosterOrThrow();
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
		deps(change, tree.path),
	);

	await store.record(change, run);
	return say(answerFor(run, warnings, tree.caveat), { run, warnings });
}

/** Ask one participant again, in place. */
async function retryOne(
	bound: Awaited<ReturnType<typeof boundFor>>,
	change: ChangeRef,
	params: AskParams,
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
	const participant =
		roster.reviewers.find((r) => r.id === asked.id) ??
		(roster.judge?.id === asked.id ? roster.judge : undefined);
	if (participant === undefined) {
		return refuse(
			`The roster no longer names "${asked.id}", so it cannot be asked again. Re-add it to the config, or run a fresh round.`,
		);
	}

	const { proposal, diff } = await material(bound);
	const tree = await treeForRound(
		bound.repo,
		proposal.headCommit,
		process.cwd(),
	);
	const single: Roster = { reviewers: [participant] };
	const { run: fresh, warnings } = await runCouncil(
		{
			roster: single,
			prompt: councilPrompt({
				proposal,
				diff,
				...(params.intent === undefined ? {} : { intent: params.intent }),
			}),
			seq: 1,
			...(proposal.headCommit === undefined
				? {}
				: { witness: proposal.headCommit }),
		},
		deps(change, tree.path),
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
 * The roster from config, or a refusal explaining what is wrong.
 *
 * Read from the package config file rather than passed in, which is
 * the whole point: a roster is a standing choice about who reviews,
 * not something to retype per call.
 */
async function rosterOrThrow(): Promise<Roster> {
	const loaded = await loadPackageConfig();
	if (!loaded.ok) {
		throw new Error(
			`The config at ${loaded.path} could not be read, so there is no roster to ask: ${loaded.error}`,
		);
	}
	const held = (loaded.config as unknown as Record<string, unknown>).review;
	const section =
		typeof held === "object" && held !== null
			? (held as Record<string, unknown>).ask
			: undefined;
	if (section === undefined) {
		throw new Error(
			`No roster is configured, so there is nobody to ask. Add a review.ask section to ${loaded.path} with a reviewers array, and optionally a judge with an id of its own.`,
		);
	}
	const parsed = parseRoster(section);
	if ("refusal" in parsed) throw new Error(parsed.refusal);
	return parsed.roster;
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
function deps(change: ChangeRef, cwd: string) {
	const findings = createFindingStore(findingDir());
	return {
		async ask(participant: Participant, prompt: string): Promise<AskAnswer> {
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
				runPi: createSpawnRunPi({ piInstall: getParentPiInstall() }),
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
	};
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
	return `${run.id}: ${summary.answered}/${summary.asked} answered${failed}, ${summary.findings} finding(s)`;
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
			lines.push(
				`${GLYPH.refused} ${outcome.participantId}: ${outcome.failure}`,
			);
		}
	}
	lines.push(...warnings);
	return lines.join("\n");
}
