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
import { builtInPersonaDir, startSpacingMs } from "../roster.ts";
import { rosterRoundRunning, runningSaid } from "../round-running.ts";
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
	const kept = spacingKeptAcrossFailedReads(() => configuredSpacing());
	const spacing = spacingAtLeast(kept.read, room.spacingMs);
	const start = await awaitCouncilStart(
		line,
		{
			by: sessionKey(),
			change,
			kind,
			leads: await isWorldWork(change),
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
		withSpacingHeld(start, kept.held()),
		room.startedUnjudged(),
	);
}

/**
 * The start's answer, saying too why the spacing it waited under was
 * held rather than read, when `held` says it was: a slow line whose
 * config can't be read otherwise looks like one set slow on purpose.
 * A round that started at once waited under no spacing, so says none.
 */
export function withSpacingHeld(
	start: CouncilStart,
	held: string | undefined,
): CouncilStart {
	if (held === undefined) return start;
	return {
		...start,
		...(start.waited === undefined
			? {}
			: { waited: `${start.waited} ${held}` }),
		...(start.cancelled === undefined
			? {}
			: { cancelled: `${start.cancelled} ${held}` }),
	};
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
 * start a third before the first showed. A config may set it wider.
 */
export const MAC_SPACING_MS = 2 * 60_000;

/**
 * The room a round reads on `platform`: a Mac waits while another
 * roster round still runs there, then reads the queue's rule for a Mac,
 * since it keeps no pressure file, and spaces its starts at least
 * {@link MAC_SPACING_MS} apart, wider where config says; Linux
 * reads its memory and CPU pressure and available memory, runs rounds
 * side by side, and alone keeps the readings a quiet machine is judged
 * on.
 */
export function roundRoom(
	platform: NodeJS.Platform,
	mac: () => RoundRoom = macRoundRoom,
	running: () => Promise<string | undefined> = macRoundRunning,
): RosterRoom {
	if (platform === "darwin") {
		const room = mac();
		return {
			short: async () => {
				const other = await running();
				if (other !== undefined) return macHeld(MAC_ROUND_RUNNING, other);
				const short = await room.short();
				return short === undefined ? undefined : macHeld(MAC_ROOM, short);
			},
			startedUnjudged: () => room.startedUnjudged(),
			spacingMs: MAC_SPACING_MS,
		};
	}
	return {
		short: () => machineShort(),
		startedUnjudged: () => undefined,
		quiet: () => machineQuiet(),
	};
}

/**
 * The room a roster round waits on: what keeps it from starting, the
 * spacing its machine keeps when the config sets none, and whether the
 * machine is quiet enough to start sooner, where it can tell.
 */
export interface RosterRoom extends Omit<RoundRoom, "short"> {
	/** What keeps a round from starting now, or nothing when there's room. */
	readonly short: () => Promise<RoomHeld | undefined>;
	/** The least spacing between starts, which the config may only widen. */
	readonly spacingMs?: number;
	/** Whether the machine is quiet; left out where it can't be read. */
	readonly quiet?: () => Promise<boolean>;
}

/** The names the line shows for what holds a Mac's round. */
const MAC_ROUND_RUNNING = "another round on this Mac";
const MAC_ROOM = "the Mac's memory";

/**
 * A Mac's hold, which is never passed in time: its rounds start one at
 * a time on what memory the queue's rule reads, and a start past either
 * runs the Mac out of it.
 */
function macHeld(reading: string, said: string): RoomHeld {
	return { said, readings: [reading], passable: false };
}

/** Why a Mac's round waits for another still running there, or nothing. */
async function macRoundRunning(): Promise<string | undefined> {
	const round = await rosterRoundRunning(runArtifactDir());
	return round === undefined ? undefined : runningSaid(round);
}

/**
 * A config read: the spacing it set, ms undefined for none; that no
 * config is there, at the path named; or why it couldn't be read.
 */
export type SpacingRead =
	| { readonly ms: number | undefined }
	| { readonly missing: string }
	| { readonly unread: string };

/** A spacing read at each look, and why the last look held one instead. */
export interface KeptSpacing {
	/** The spacing to go by now, undefined for none set. */
	readonly read: () => Promise<number | undefined>;
	/** Why the last read held a spacing rather than reading one, if it did. */
	readonly held: () => string | undefined;
}

/**
 * A spacing reader that answers, when a read fails, what the last good
 * read said, so a config caught half-saved while rounds wait takes none
 * of them to the quickest pace. A first read that fails answers the
 * line's default, as though nothing were known, since the config may
 * set a wide spacing for what pressure can't show. A config gone once a
 * read found it holds what it set too, since a save that renames the
 * old file aside leaves the path empty for a moment. One gone at the
 * first read is a machine with no config, which must not wait for one.
 */
export function spacingKeptAcrossFailedReads(
	read: () => Promise<SpacingRead>,
): KeptSpacing {
	let kept:
		| { readonly ms: number | undefined; readonly found: boolean }
		| undefined;
	let held: string | undefined;
	return {
		read: async () => {
			const now = await read();
			held = undefined;
			if ("ms" in now) {
				kept = { ms: now.ms, found: true };
			} else if ("unread" in now || kept?.found === true) {
				held = heldSaid(now, kept !== undefined);
			} else {
				kept = { ms: undefined, found: false };
			}
			return kept === undefined ? COUNCIL_START_SPACING_MS : kept.ms;
		},
		held: () => held,
	};
}

/** Why a read that found no spacing held one, as a round's answer says. */
function heldSaid(
	read: { readonly missing: string } | { readonly unread: string },
	known: boolean,
): string {
	const why =
		"missing" in read
			? `The config at ${read.missing} was gone at the last look`
			: `The config couldn't be read at the last look (${read.unread})`;
	const what = known
		? "the spacing it last set held"
		: `the line's default of ${COUNCIL_START_SPACING_MS / 60_000} minutes held`;
	return `${why}, so ${what}.`;
}

/**
 * The spacing the config at `path` sets between round starts, with ms
 * undefined for none, so rounds start on room, two a minute at most, or
 * quicker while the machine is quiet. A config that can't be read, or
 * sets `startSpacingMinutes` to what isn't a number of minutes, says
 * why rather than reading as none, since it may be meant to set a wide
 * spacing; one that isn't there says so.
 */
export async function configuredSpacing(path?: string): Promise<SpacingRead> {
	const loaded = await loadPackageConfig(path);
	if (!loaded.ok) return { unread: loaded.error };
	if (loaded.missing === true) return { missing: loaded.path };
	const review = loaded.config.sections[REVIEW_SLUG];
	const ask = isRecord(review) ? review.ask : undefined;
	const ms = startSpacingMs(ask);
	if (
		ms === undefined &&
		isRecord(ask) &&
		ask.startSpacingMinutes !== undefined
	) {
		return {
			unread: `startSpacingMinutes in ${loaded.path} is ${JSON.stringify(ask.startSpacingMinutes)}, not a number of minutes`,
		};
	}
	return { ms };
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
