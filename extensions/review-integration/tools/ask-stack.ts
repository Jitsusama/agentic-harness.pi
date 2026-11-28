/**
 * The `review_ask` round over a whole stack: every change put to every
 * reviewer together, read from one tree cut at the tip.
 *
 * Apart from the council over one change (`ask-council.ts`) because it
 * changes with how a stack is read, how its findings are filed against
 * each change and what its reviewers are told the stack touches.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnExec } from "../../../lib/core/exec/index.ts";
import { tooLargeToAsk } from "../../../lib/core/review/ask/prompt.ts";
import { stackAliases } from "../../../lib/core/review/ask/span.ts";
import { stackWitnesses } from "../../../lib/core/review/ask/stack-witness.ts";
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
import {
	saidOfTree,
	stackFilesToRead,
	treeForRound,
	unpinnedOf,
} from "../work.ts";
import { answerFor } from "./ask-answer.ts";
import { deps, ISOLATED } from "./ask-reviewer.ts";
import { type RoundSeat, rosterOrThrow } from "./ask-roster.ts";
import {
	type AskParams,
	awaitRosterStart,
	chartersFor,
	claimIdentities,
	nextSeq,
	refsOf,
	rereadFailed,
	treeGone,
	waitChanged,
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
 *
 * Built before its wait for a start and read again after it: on 28
 * November a stack round over mycelium #473 to #497 read heads five
 * commits old, built hours before it started.
 */
export async function askStack(
	pi: ExtensionAPI,
	bound: Awaited<ReturnType<typeof boundFor>>,
	params: AskParams,
	seat: RoundSeat,
	watch: RoundWatch,
): Promise<Answer> {
	const { roster } = await rosterOrThrow(params, "reviewers", seat);
	const { engine } = await reviewEngine(pi);

	// The stack and each proposed change's diff: the material, read once
	// before the wait and again after it, since the wait can last hours.
	const readStack = async () => {
		const stack = await bound.stack();
		if (!stack) {
			return {
				refused: refuse(
					`The ${bound.provider.id} provider does not read stacks, so there is no stack to put to anybody. Ask about the one change with review_ask council.`,
				),
			};
		}

		// A node's own ref is a git ref and its proposal's ref is a
		// ChangeRef. Both are called ref and they are not the same thing, so
		// they stay in separate fields rather than being spread together.
		const proposed = stack.nodes.flatMap((node) =>
			node.change === undefined
				? []
				: [{ ref: node.ref, proposal: node.change }],
		);
		if (proposed.length === 0) {
			return {
				refused: refuse(
					"No branch in this stack has been proposed as a change, so there is nothing to read. A stack of branches nobody has proposed is still a stack, but it carries no bodies or diffs to review.",
				),
			};
		}

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
		return { nodes: stack.nodes.length, changes };
	};
	type StackRead = Exclude<
		Awaited<ReturnType<typeof readStack>>,
		{ refused: Answer }
	>;

	// Everything that follows from the material, made once before the
	// wait and again after it.
	const build = async ({ nodes, changes }: StackRead) => {
		await Promise.all(
			changes.map((one) =>
				claimIdentities(one.change, "reviewer", roster.reviewers),
			),
		);

		const tip = changes[changes.length - 1];
		if (tip === undefined) {
			return { refused: refuse("This stack reports no changes to read.") };
		}
		const tree = await treeForRound(
			bound.repo,
			tip.proposal.headCommit,
			params.repo ?? seat.cwd,
			// Every change's files that the tip still holds, since the tip
			// holds the whole stack's work.
			stackFilesToRead(changes.map((one) => one.diff)),
		);
		if ("refusal" in tree) return { refused: refuse(tree.refusal) };
		// Every change in the stack, since a lens the stack edits anywhere
		// is a lens the stack's author wrote. A node carrying no proposal
		// carries no diff, and the tree read is the tip, which holds its
		// work anyway: what the stack touches is then unknowable rather
		// than merely smaller, so it is said rather than understated.
		const charters = await chartersFor(
			roster,
			tree,
			"reviewers",
			nodes === changes.length
				? { files: changes.flatMap((one) => one.diff.files) }
				: {
						unknown: `${nodes - changes.length} of this stack's ${nodes} branches have not been put up as changes, so they carry no diff, and the tree read is the tip that holds their work.`,
					},
		);

		// Only a head the tip's tree holds was read, so only that one is
		// recorded; a member pushed past the tip, or a fanned-out sibling,
		// is said as unread.
		const { held: witnesses, unheld } = await stackWitnesses(
			spawnExec({ signal: seat.signal }),
			tree.path,
			tip.proposal.headCommit,
			new Map(changes.map((one) => [one.ref, one.proposal.headCommit])),
		);

		// The same honest answer the charters get twenty lines up: a stack
		// whose nodes are not all proposed knows less about what it touches
		// than the tree it reads contains.
		const conventions = await guidanceFor(
			tree,
			nodes === changes.length
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
		if (tooLarge !== undefined) return { refused: refuse(tooLarge) };
		return {
			changes,
			tip,
			tree,
			charters,
			witnesses,
			unheld,
			conventions,
			prompt,
		};
	};

	const read = await readStack();
	if (read.refused !== undefined) return read.refused;
	const first = await build(read);
	if (first.refused !== undefined) return first.refused;
	// What the round reads: what was built before its wait, or what was
	// built again after it, which is what a start decided then follows.
	let built = first;
	const start = await awaitRosterStart(
		built.tip.change.label,
		seat.signal,
		"stack",
	);
	if (start.cancelled !== undefined) return refuse(start.cancelled);
	let rebuiltSaid: string | undefined;
	// Read again and built again after a wait, keeping the start held:
	// building asks for the tree again, which dates a still one so no
	// sweep takes it as the reviewers start, and cuts afresh one a sweep
	// took. Each change is bound afresh as it is read, so its diff is the
	// one there now. Refused, or failing, it gives its slot back.
	if (start.waited !== undefined) {
		const wasGone = treeGone(built.tree);
		let again: Awaited<ReturnType<typeof readStack>>;
		let rebuilt: Awaited<ReturnType<typeof build>>;
		try {
			again = await readStack();
			rebuilt = again.refused === undefined ? await build(again) : again;
		} catch (error) {
			await start.release?.();
			return refuse(rereadFailed(error));
		}
		if (again.refused !== undefined) {
			await start.release?.();
			return again.refused;
		}
		if (rebuilt.refused !== undefined) {
			await start.release?.();
			return rebuilt.refused;
		}
		rebuiltSaid = waitChanged(
			refsOf(built.changes),
			refsOf(again.changes),
			wasGone,
		);
		built = rebuilt;
	}
	const { changes, tip, tree, charters, witnesses, unheld } = built;
	const { conventions, prompt } = built;
	const stackRefs = changes.map((one) => one.ref);
	const changeFor = new Map(changes.map((one) => [one.ref, one.change]));
	const findings = createFindingStore(findingDir());
	const asking = deps(tip.change, tree.path, watch, charters);
	const { run, warnings } = await runStackCouncil(
		{
			roster,
			prompt,
			seq: nextSeq(),
			stackRefs,
			// A reviewer reads each change's title and body, which name it
			// by its number, so a finding said at that number is placed.
			aliases: stackAliases(
				changes.map((one) => ({
					ref: one.ref,
					change: one.change,
					...(one.proposal.url === undefined ? {} : { url: one.proposal.url }),
				})),
			),
			witnessFor: (ref) => witnesses.get(ref),
			witnesses: [...witnesses.values()],
			// Per-change witnesses, but one tree, so the caveat is about
			// the round exactly as it is for every other kind.
			...(unpinnedOf(tree) === undefined ? {} : { unpinned: unpinnedOf(tree) }),
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
			...(start.waited === undefined ? [] : [start.waited]),
			...(rebuiltSaid === undefined ? [] : [rebuiltSaid]),
			...(unheld.length === 0
				? []
				: [
						`Not recorded as read: ${unheld.join(", ")}, whose head the tip's tree doesn't hold. Restack onto it and ask again to have it count.`,
					]),
			answerFor(run, warnings, saidOfTree(tree)),
		].join("\n"),
		{ run, warnings, refs: stackRefs },
	);
}
