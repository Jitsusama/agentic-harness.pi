/**
 * The `review_ask` rounds that weigh what is already said rather than
 * raising findings of their own: a judge consolidating a council, a
 * critique pushing back on what the judge concluded, and an audit of
 * the inbound threads against the change.
 *
 * Apart from the council rounds (`ask-council.ts`) because each of
 * these reads an earlier round or a conversation, and changes with how
 * that material is put to the one weighing it and what it may conclude.
 */

import {
	auditPrompt,
	type ChangeRef,
	type Critique,
	createRunStore,
	critiquePrompt,
	describeAnchor,
	givenBy,
	guidanceFor,
	judgePrompt,
	runAudit,
	runCritique,
	runJudge,
	type Thread,
	type ThreadAudit,
} from "../../../lib/core/review/index.ts";
import { runDir } from "../engine.ts";
import type { RoundWatch } from "../progress.ts";
import { roundToRead } from "../round-to-read.ts";
import { readFrom, treeForRound } from "../work.ts";
import { answerFor, judgeHandOff } from "./ask-answer.ts";
import { deps, ISOLATED } from "./ask-reviewer.ts";
import { type RoundSeat, rosterOrThrow } from "./ask-roster.ts";
import {
	type AskParams,
	chartersFor,
	claimIdentities,
	findingsOf,
	material,
	nextSeq,
	renderFindings,
} from "./ask-round.ts";
import { collectFinished } from "./ask-settle.ts";
import {
	type Answer,
	type boundFor,
	hostedChange,
	refuse,
	say,
} from "./shared.ts";

/** Ask the judge to consolidate the latest council. */
export async function askJudge(
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
export async function askCritique(
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
 * Judge the inbound threads against the change.
 *
 * Advisory by construction: it never posts and raises no findings.
 * Answering a thread is a decision about how to talk to a person, and
 * this only makes it a better informed one.
 */
export async function askAudit(
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
