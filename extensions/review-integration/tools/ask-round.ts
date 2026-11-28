/**
 * What every `review_ask` round shares before anybody is asked: what a
 * call passes, which ids mean which participants, the round's place in
 * this session's sequence, the change and its diff, each participant's
 * charter, and the findings an earlier round raised.
 *
 * Apart from the rounds in `ask-council.ts`, `ask-weigh.ts` and
 * `ask-stack.ts` because these change with what a round is asked about,
 * not with how any one kind of round runs.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	macRoundRoom,
	type RoundRoom,
} from "../../../lib/core/review/ask/mac-room.ts";
import {
	awaitCouncilStart,
	COUNCIL_START_SPACING_MS,
	type CouncilStart,
	newestRosterStartIn,
	type RoomHeld,
} from "../../../lib/core/review/ask/start-spacing.ts";
import {
	type AskRun,
	type ChangeRef,
	createFindingStore,
	createIdentityLedger,
	type DiffModel,
	type Finding,
	lensesFor,
	type Participant,
	type ParticipantOverride,
	type Roster,
	type RunStore,
	touchedBy,
} from "../../../lib/core/review/index.ts";
import { loadPackageConfig } from "../../../lib/internal/config/loader.ts";
import {
	machineQuiet,
	machineShort,
} from "../../../lib/internal/machine/room.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import { REVIEW_SLUG } from "../config.ts";
import {
	councilStartsPath,
	findingDir,
	personaDir,
	runArtifactDir,
	sessionKey,
} from "../engine.ts";
import { rangeProposal } from "../range.ts";
import {
	builtInPersonaDir,
	macRoundsAtOnce,
	startSpacingMs,
} from "../roster.ts";
import {
	type RunningRound,
	roundsHeld,
	SETTLED_AFTER_MS,
} from "../round-running.ts";
import { markStart, roundsStartingOrRunning } from "../round-starting.ts";
import { roundToRead } from "../round-to-read.ts";
import type { ReadableTree } from "../work.ts";
import { isWorldWork, urgentMarks } from "./ask-line.ts";
import type { RoundAsks } from "./ask-roster.ts";
import {
	type Answer,
	type boundFor,
	refuse,
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

/**
 * Free an id, so it can mean something else.
 *
 * The escape hatch the refusal names. It is deliberately explicit
 * rather than automatic: releasing one costs the ability to tell which
 * participant older findings came from, and that is a person's call
 * rather than a convenience the tool applies quietly.
 */
export function releaseIdentity(params: AskParams): Answer {
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
export async function claimIdentities(
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

/** The rounds that ask the whole roster at once, each waiting its own turn. */
export type RosterRound = "council" | "stack" | "critique";

/**
 * Takes the machine's next start for a round that asks the whole
 * roster at once (a council, a stack or a critique) and waits for it,
 * answering what the round should say about the wait, or why it was
 * stopped while it waited.
 *
 * Called last, once nothing else refuses the round, so only a round
 * about to start its reviewers holds the slot. A judge, an audit and a
 * retry each ask one participant, so they start whenever they are asked.
 */
export async function awaitRosterStart(
	change: string,
	signal: AbortSignal | undefined,
	kind: RosterRound,
	room: RosterRoom = roundRoom(process.platform),
): Promise<CouncilStart> {
	// A round a session on an older install started never joined the
	// line, but its reviewers' folder says when it began, read again at
	// each look since such rounds start while this one waits.
	const runs = join(runArtifactDir(), "runs");
	const line = councilStartsPath();
	const spacing = spacingAtLeast(
		spacingKeptAcrossFailedReads(configuredSpacing),
		room.spacingMs,
	);
	const start = await awaitCouncilStart(
		line,
		{
			by: sessionKey(),
			change,
			kind,
			leads: await isWorldWork(change),
			...(room.away === true ? { away: true } : {}),
			urgent: () => urgentMarks(line),
			startedElsewhere: () => newestRosterStartIn(runs),
			room: () => room.short(),
			...(room.quiet === undefined ? {} : { quiet: room.quiet }),
			// Read at each look, so a spacing set while rounds wait reaches
			// them; never under the room's own, which a config can't narrow.
			spacing,
		},
		signal,
	);
	return withUnjudged(
		await markedWhileStarting(start, room.markStart),
		room.startedUnjudged(),
	);
}

/**
 * The start, marked by `mark` as taken until its round's folder shows
 * it, where its room keeps such marks, and giving the mark back with
 * the start. A mark that can't be written leaves the start as it was:
 * the round still starts, and is counted once its folder is made, as
 * every round was before marks.
 */
export async function markedWhileStarting(
	start: CouncilStart,
	mark: RosterRoom["markStart"],
): Promise<CouncilStart> {
	if (mark === undefined || start.cancelled !== undefined) return start;
	let unmark: (() => Promise<void>) | undefined;
	try {
		unmark = await mark();
	} catch {
		// Unmarked, it is counted once its folder is made, as before marks.
		return start;
	}
	const release = async (): Promise<void> => {
		await unmark?.().catch(() => {
			// Left, the mark holds starts until it ages out, never longer.
		});
		await start.release?.();
	};
	return { ...start, release };
}

/**
 * The start's answer, saying too that the round started though its
 * room couldn't be judged, when `unjudged` says it did.
 */
export function withUnjudged(
	start: CouncilStart,
	unjudged: string | undefined,
): CouncilStart {
	if (unjudged === undefined) return start;
	return {
		...start,
		waited: [start.waited, unjudged].filter(Boolean).join(" "),
	};
}

/**
 * A spacing reader that never answers under `floor`, where one is
 * given: a config may widen a machine's own spacing, never narrow it.
 */
export function spacingAtLeast(
	read: () => Promise<number | undefined>,
	floor: number | undefined,
): () => Promise<number | undefined> {
	if (floor === undefined) return read;
	return async () => Math.max((await read()) ?? 0, floor);
}

/**
 * The least a Mac leaves between round starts, whatever its config
 * sets: its swap-outs show a round's reviewers only once they have
 * loaded, a minute or more after the start, so two a minute would
 * start a third before the first showed. It is the time a round takes
 * to settle in, so no start passes beside the last before its reviewers
 * load. A round takes its start before it reads its change again and
 * cuts its tree, which can take longer than this, so a Mac's round
 * also marks its start until its folder is made (`round-starting.ts`),
 * and the count and the age read the mark meanwhile. A config may set
 * it wider.
 */
export const MAC_SPACING_MS = SETTLED_AFTER_MS;

/**
 * The room a round reads on `platform`: a Mac waits while the roster
 * rounds running there number the config's `review.mac.roundsAtOnce`,
 * one unless it says more, and below that while any of them is young
 * or its memory reads too little free for another, as `roundsHeld`
 * judges; then it reads the queue's rule for a Mac, since it keeps no
 * pressure file, and spaces its starts at least
 * {@link MAC_SPACING_MS} apart, wider where config says; Linux
 * reads its memory and CPU pressure and available memory, runs rounds
 * side by side, and alone keeps the readings a quiet machine is judged
 * on.
 */
export function roundRoom(
	platform: NodeJS.Platform,
	mac: () => RoundRoom = macRoundRoom,
	running: () => Promise<readonly RunningRound[]> = macRoundsRunning,
	atOnce: () => Promise<number> = configuredRoundsAtOnce,
	mark: () => Promise<() => Promise<void>> = macStartMarked,
): RosterRoom {
	if (platform === "darwin") {
		const room = mac();
		return {
			short: async () => {
				const held = await roundsHeld(await running(), await atOnce(), () =>
					room.freePercent(),
				);
				if (held !== undefined) {
					const reading = held.by === "free" ? MAC_ROOM : MAC_ROUND_RUNNING;
					return macHeld(reading, held.said);
				}
				const short = await room.short();
				return short === undefined ? undefined : macHeld(MAC_ROOM, short);
			},
			startedUnjudged: () => room.startedUnjudged(),
			spacingMs: MAC_SPACING_MS,
			markStart: mark,
		};
	}
	return {
		short: () => machineShort(),
		startedUnjudged: () => undefined,
		quiet: () => machineQuiet(),
	};
}

/**
 * The room a round whose reviewers run on a room waits on: none of this
 * machine's, since its reviewers load and think there. It stands in the
 * line ahead of the rounds that wait on this machine's bars, since none
 * of those holds it, and keeps the spacing. On 27 November optimus's
 * line held 57 rounds behind its memory bar, which a round sent to a
 * room would have waited behind too.
 */
export const ROOM_ROUND: RosterRoom = {
	short: async () => undefined,
	startedUnjudged: () => undefined,
	away: true,
};

/**
 * The room a roster round waits on: what keeps it from starting, the
 * spacing its machine keeps when the config sets none, and whether the
 * machine is quiet enough to start sooner, where it can tell.
 */
export interface RosterRoom extends Omit<RoundRoom, "short" | "freePercent"> {
	/** What keeps a round from starting now, or nothing when there's room. */
	readonly short: () => Promise<RoomHeld | undefined>;
	/** The least spacing between starts, which the config may only widen. */
	readonly spacingMs?: number;
	/** Whether the machine is quiet; left out where it can't be read. */
	readonly quiet?: () => Promise<boolean>;
	/** Whether the round's reviewers run on another machine. */
	readonly away?: boolean;
	/**
	 * Marks a start taken, for `short` to count until the round's folder
	 * shows it, answering what takes the mark back; left out where
	 * nothing counts rounds by their folders.
	 */
	readonly markStart?: () => Promise<() => Promise<void>>;
}

/** The names the line shows for what holds a Mac's round. */
const MAC_ROUND_RUNNING = "another round on this Mac";
const MAC_ROOM = "the Mac's memory";

/**
 * A Mac's hold, which is never passed in time: its rounds start as
 * many at a time as its config allows on what memory the queue's rule
 * reads, and a start past either runs the Mac out of it.
 */
function macHeld(reading: string, said: string): RoomHeld {
	return { said, readings: [reading], passable: false };
}

/** The roster rounds on this Mac still taking their start, then those running. */
function macRoundsRunning(): Promise<readonly RunningRound[]> {
	return roundsStartingOrRunning(runArtifactDir());
}

/** Marks a start this Mac's round took, until its folder shows it. */
function macStartMarked(): Promise<() => Promise<void>> {
	return markStart(runArtifactDir());
}

/**
 * How many roster rounds this Mac's config lets run at once, read at
 * each look as the spacing is, so a value set while rounds wait reaches
 * them. One when the config can't be read, as for a bad value, since
 * one at a time only waits longer.
 */
async function configuredRoundsAtOnce(): Promise<number> {
	const loaded = await loadPackageConfig();
	if (!loaded.ok) return 1;
	const review = loaded.config.sections[REVIEW_SLUG];
	return macRoundsAtOnce(isRecord(review) ? review.mac : undefined);
}

/** A config read: what it set, or that it couldn't be read. */
type SpacingRead = { readonly ms: number | undefined } | undefined;

/**
 * A spacing reader that answers, when a read fails, what the last good
 * read said, so a config caught half-saved while rounds wait takes none
 * of them to the quickest pace. A first read that fails answers the
 * line's default, as though nothing were known, since the config may
 * set a wide spacing for what pressure can't show.
 */
export function spacingKeptAcrossFailedReads(
	read: () => Promise<SpacingRead>,
): () => Promise<number | undefined> {
	let kept: { readonly ms: number | undefined } | undefined;
	return async () => {
		kept = (await read()) ?? kept;
		return kept === undefined ? COUNCIL_START_SPACING_MS : kept.ms;
	};
}

/**
 * The spacing this machine's config sets between round starts, with ms
 * undefined for none, so rounds start on room, two a minute at most, or
 * quicker while the machine is quiet. Undefined when the config can't be
 * read, rather than stopping a round over a setting it may not even hold.
 */
async function configuredSpacing(): Promise<SpacingRead> {
	const loaded = await loadPackageConfig();
	if (!loaded.ok) return undefined;
	const review = loaded.config.sections[REVIEW_SLUG];
	return { ms: startSpacingMs(isRecord(review) ? review.ask : undefined) };
}

/**
 * Each participant's charter, from the operator's personas and the
 * repo's own agents together.
 *
 * The composition itself lives in `lenses.ts`, where it can be driven
 * against a directory. What stays here is the one decision this side
 * owns: where an operator's personas live, which is an environment
 * question and not a review one.
 */
export function chartersFor(
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
 * The change and its diff, which every round needs. A local range has no
 * proposal of its own to read, so its commits stand in for one.
 */
export async function material(bound: Awaited<ReturnType<typeof boundFor>>) {
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

/** Where a change a round reads stands: its head and its base. */
interface ChangeStands {
	readonly head: string | undefined;
	readonly base: string | undefined;
}

/** Where each change a round reads stands, keyed by its label. */
export type RoundRefs = ReadonlyMap<string, ChangeStands>;

/** Where each of a round's changes stands, as its proposals say. */
export function refsOf(
	changes: readonly {
		readonly change: { readonly label: string };
		readonly proposal: {
			readonly headCommit?: string | undefined;
			readonly baseCommit?: string | undefined;
		};
	}[],
): RoundRefs {
	return new Map(
		changes.map(({ change, proposal }) => [
			change.label,
			{ head: proposal.headCommit, base: proposal.baseCommit },
		]),
	);
}

/**
 * What a round says of what changed while it waited for its start, or
 * nothing when all held still. Heads first: each that moved, and each
 * change that came into the round or left it. Else bases, since a still
 * head over a moved base is another diff. Else a tree a sweep took,
 * which building again cut afresh.
 */
export function waitChanged(
	before: RoundRefs,
	after: RoundRefs,
	treeWasGone: boolean,
): string | undefined {
	const labels = [...new Set([...before.keys(), ...after.keys()])];
	const heads = labels.flatMap((label) => {
		const from = before.get(label);
		const to = after.get(label);
		if (from === undefined) return [`${label} came in at ${short(to?.head)}`];
		if (to === undefined) return [`${label} left it`];
		return from.head === to.head
			? []
			: [`${label} from ${short(from.head)} to ${short(to.head)}`];
	});
	if (heads.length > 0) {
		const which = heads.length === 1 ? "a head" : `${heads.length} heads`;
		return `While it waited, ${which} moved, so it reads what is there now: ${heads.join("; ")}.`;
	}
	const bases = labels.flatMap((label) => {
		const from = before.get(label)?.base;
		const to = after.get(label)?.base;
		return from === to ? [] : [`${label} from ${short(from)} to ${short(to)}`];
	});
	if (bases.length > 0) {
		const which = bases.length === 1 ? "a base" : `${bases.length} bases`;
		return `While it waited, ${which} moved, so it reads the diff there is now: ${bases.join("; ")}.`;
	}
	return treeWasGone ? TREE_CUT_AGAIN : undefined;
}

/** A head as a round's answer names it: its first eight characters. */
function short(head: string | undefined): string {
	return head === undefined ? "nothing" : head.slice(0, 8);
}

/**
 * Whether the folder a round was to read is gone, as a snapshot cut
 * before an hours-long wait can be by its start. A reviewer started in a
 * folder that isn't there fails at once: Node says so as ENOENT on the
 * binary it spawned, not on the folder.
 */
export function treeGone(tree: ReadableTree): boolean {
	return !existsSync(tree.path);
}

/** What a round says when the tree it cut was gone by its start. */
const TREE_CUT_AGAIN =
	"While it waited, the tree it was to read was gone, so it was cut again.";

/**
 * What a round says when the change couldn't be read again after its
 * wait, so it starts nothing rather than reading what may be stale.
 */
export function rereadFailed(error: unknown): string {
	const why = error instanceof Error ? error.message : String(error);
	return `While it waited for its start, the change couldn't be read again, so it starts nothing rather than read what may have moved: ${why.replace(/\.$/, "")}. Its place in the line is given back; ask again once the change reads.`;
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
export async function councilFindingsBehind(
	change: ChangeRef,
	store: RunStore,
	basis: string | undefined,
): Promise<Finding[]> {
	const chosen = await roundToRead(store, change, "council", basis);
	return "run" in chosen ? await findingsOf(change, chosen.run) : [];
}

/** The findings one round raised, in the order it raised them. */
export async function findingsOf(
	change: ChangeRef,
	run: AskRun,
): Promise<Finding[]> {
	const all = await createFindingStore(findingDir()).list(change);
	const wanted = new Set(run.outcomes.flatMap((o) => o.findingIds));
	return all.filter((finding) => wanted.has(finding.id));
}

/** Findings as a judge reads them, attribution and all. */
export function renderFindings(findings: Finding[]): string {
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
