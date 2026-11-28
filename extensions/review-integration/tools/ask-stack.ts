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
import type { CouncilStart } from "../../../lib/core/review/ask/start-spacing.ts";
import {
	type ChangeRef,
	createFindingStore,
	createRunStore,
	givenBy,
	guidanceFor,
	runStackCouncil,
	stackPrompt,
} from "../../../lib/core/review/index.ts";
import type { RoomAsk } from "../../../lib/subagent/run-contract.ts";
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
import {
	briefFitsARoom,
	type RoomHarness,
	roomFor,
	roomHarness,
} from "./ask-room.ts";
import { type RoundSeat, rosterOrThrow } from "./ask-roster.ts";
import {
	type AskParams,
	awaitRosterStart,
	chartersFor,
	claimIdentities,
	nextSeq,
	ROOM_ROUND,
	type RosterRoom,
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
	// A room is weighed before the wait, so a round bound for one waits on
	// no bar here, and settled after it from the heads as they are then.
	const begun = await beginStackRound(stackStartOf(built, seat.signal));
	const { start } = begun;
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
	// After the reread, so a member pushed past the tip while the round
	// waited keeps it here.
	const settled = await settleStackRoom(
		begun,
		stackStartOf(built, seat.signal),
	);
	if (settled.start.cancelled !== undefined)
		return refuse(settled.start.cancelled);
	const { room } = settled;
	const asking = deps(tip.change, tree.path, watch, charters, undefined, room);
	const { run, warnings } = await runStackCouncil(
		{
			roster,
			prompt,
			seq: nextSeq(),
			stackRefs,
			// A reviewer reads each change's title and body, which name it
			// by its number, so a finding said at that number is placed.
			aliases: stackAliases(changes),
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
			...(settled.start.waited === undefined ? [] : [settled.start.waited]),
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

/** What a stack round's start is decided from. */
export interface StackStartAsk {
	/** The tip, whose tree the round reads. */
	readonly tip: ChangeRef;
	/** The tip's head, the one commit a room's reviewer checks out. */
	readonly head: string | undefined;
	/** The round's prompt, which a room's start must carry. */
	readonly prompt: string;
	/** The members whose head the tip's tree doesn't hold. */
	readonly unheld: readonly string[];
	/** The code a room's reviewers read, asked only once a room is named. */
	readonly harness: () => RoomHarness;
	/** Stops the wait. */
	readonly signal: AbortSignal | undefined;
}

/** Where a stack round's start reads its room and this machine's bars. */
export interface StackStartReads {
	/** The room the tip's reviewers would run on now, or nothing. */
	readonly roomOf: (
		change: ChangeRef,
		head: string | undefined,
		harness: () => RoomHarness,
	) => Promise<RoomAsk | undefined>;
	/** This machine's bars; left out, its platform's own. */
	readonly here?: RosterRoom;
}

/** The room and the bars a stack round reads outside a test. */
const READS: StackStartReads = {
	roomOf: (change, head, harness) => roomFor(change, head, harness),
};

/**
 * The room a stack round's reviewers run on, or nothing when they run
 * here. A room's reviewer checks out one commit, the tip's, so the
 * round goes there only when the tip's tree holds every member's head,
 * and only with a prompt a room's start can carry.
 *
 * Asked before the wait and again after it, from the stack as the
 * round built it again then: a member pushed while it waited may no
 * longer be held by the tip.
 */
async function stackRoom(
	ask: StackStartAsk,
	reads: StackStartReads = READS,
): Promise<RoomAsk | undefined> {
	if (ask.unheld.length > 0 || !briefFitsARoom(ask.prompt)) return undefined;
	return await reads.roomOf(ask.tip, ask.head, ask.harness);
}

/** What a stack round built, as much of it as its start is decided from. */
interface BuiltForStart {
	readonly tip: {
		readonly change: ChangeRef;
		readonly proposal: { readonly headCommit?: string };
	};
	readonly prompt: string;
	readonly unheld: readonly string[];
	readonly tree: { readonly path: string };
}

/** The start a stack round asks for, from what it built. */
function stackStartOf(
	built: BuiltForStart,
	signal: AbortSignal | undefined,
): StackStartAsk {
	return {
		signal,
		tip: built.tip.change,
		head: built.tip.proposal.headCommit,
		prompt: built.prompt,
		unheld: built.unheld,
		harness: () => roomHarness(built.tree.path),
	};
}

/** A stack round's start as its wait ended, and the room it waited for. */
export interface StackRoundBegun {
	readonly start: CouncilStart;
	/** The room weighed before the wait, which let it pass the bars. */
	readonly asked: RoomAsk | undefined;
}

/**
 * Waits for a stack round's start, as a council waits for its own: past
 * this machine's bars when its reviewers would run on a room, since they
 * load and think there, and on the bars otherwise.
 */
export async function beginStackRound(
	ask: StackStartAsk,
	reads: StackStartReads = READS,
): Promise<StackRoundBegun> {
	const asked = await stackRoom(ask, reads);
	const start = await awaitRosterStart(
		ask.tip.label,
		ask.signal,
		"stack",
		asked === undefined ? reads.here : ROOM_ROUND,
	);
	return { start, asked };
}

/**
 * The room a begun stack round's reviewers run on, weighed again from
 * `ask`, the stack as the round built it after its wait, which can last
 * hours. A room taken out of the config meanwhile, or a member the tip
 * no longer holds, gives the start back and waits on the bars here.
 */
export async function settleStackRoom(
	begun: StackRoundBegun,
	ask: StackStartAsk,
	reads: StackStartReads = READS,
): Promise<{ start: CouncilStart; room: RoomAsk | undefined }> {
	const { start, asked } = begun;
	if (start.cancelled !== undefined || asked === undefined) {
		return { start, room: undefined };
	}
	const room = await stackRoom(ask, reads);
	if (room !== undefined) return { start, room };
	await start.release?.();
	const local = await awaitRosterStart(
		ask.tip.label,
		ask.signal,
		"stack",
		reads.here,
	);
	// What it said of its first wait, when the second said nothing.
	const waited = local.waited ?? start.waited;
	return {
		start: waited === undefined ? local : { ...local, waited },
		room: undefined,
	};
}
