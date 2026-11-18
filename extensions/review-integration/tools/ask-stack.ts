/**
 * The `review_ask` round over a whole stack: every change put to every
 * reviewer together, read from one tree cut at the tip.
 *
 * Apart from the council over one change (`ask-council.ts`) because it
 * changes with how a stack is read, how its findings are filed against
 * each change and what its reviewers are told the stack touches.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tooLargeToAsk } from "../../../lib/core/review/ask/prompt.ts";
import {
	createFindingStore,
	createRunStore,
	givenBy,
	guidanceFor,
	runStackCouncil,
	stackPrompt,
} from "../../../lib/core/review/index.ts";
import { findingDir, reviewEngine, runDir } from "../engine.ts";
import type { RoundWatch } from "../progress.ts";
import { treeForRound } from "../work.ts";
import { answerFor } from "./ask-answer.ts";
import { deps, ISOLATED } from "./ask-reviewer.ts";
import { type RoundSeat, rosterOrThrow } from "./ask-roster.ts";
import {
	type AskParams,
	chartersFor,
	claimIdentities,
	nextSeq,
} from "./ask-round.ts";
import { type Answer, type boundFor, refuse, say } from "./shared.ts";

/**
 * Ask the roster about the whole stack at once.
 *
 * Every change is put to every reviewer together, which is the only
 * way a finding that lives between changes can be seen at all. The
 * tree is cut at the tip, since the tip's checkout holds every change
 * below it: a stack applies in order, so reading the tip is reading
 * the stack as it will land.
 */
export async function askStack(
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
	const prompt = stackPrompt({
		changes: changes.map((one) => ({
			ref: one.ref,
			proposal: one.proposal,
			diff: one.diff,
		})),
		...(params.intent === undefined ? {} : { intent: params.intent }),
		...conventions,
	});
	const tooLarge = tooLargeToAsk(
		prompt,
		"Ask about fewer of its changes: a council on each change, or on the lower part of the stack first.",
	);
	if (tooLarge !== undefined) return refuse(tooLarge);
	const asking = deps(tip.change, tree.path, watch, charters);
	const { run, warnings } = await runStackCouncil(
		{
			roster,
			prompt,
			seq: nextSeq(),
			stackRefs,
			witnessFor: (ref) => witnesses.get(ref),
			witnesses: [...witnesses.values()].filter(
				(sha): sha is string => sha !== undefined,
			),
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
