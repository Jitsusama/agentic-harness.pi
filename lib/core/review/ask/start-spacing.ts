/**
 * Spacing between council starts on one machine, in order of asking.
 *
 * A council starts several reviewer processes at once, each holding a
 * pi's worth of memory for minutes. The rule is one roster start on the
 * machine per three minutes (1OGSE7, 22 November). Sessions kept it by
 * reading the mesh, and between 03:44 and 04:00 that day starts came
 * every few minutes, because two sessions that each read "no start
 * lately" both start (24bf7116). Refusing the second sends it back to
 * try again, which costs turns and wakeups and lets the fastest poller
 * win. So each round takes a place in a line every session on the
 * machine keeps under one lock, and starts once it is first and a
 * spacing has passed since the last start.
 *
 * The line used to be fixed times: each claim took the slot a spacing
 * after the last one taken and slept until it. A round given up while
 * it waited left its slot as a gap, and so did one whose session ended
 * or reloaded. On 22 November starts came every three minutes until
 * 01:12Z, then every nine to thirteen, while the last slot kept sat at
 * 03:30Z: one round in four was starting, and every round asked waited
 * an hour and forty minutes behind slots nobody would use. So a place
 * is a ticket naming its process, not a time. The spacing runs from the
 * last start that really happened, and a ticket whose process is gone
 * is dropped by whoever reads the line next, so nothing waits behind a
 * round that will never start.
 *
 * A fixed spacing guarded nothing it should: on 24 November a round
 * waited about 30 minutes behind ten others on a machine with memory
 * for all of them. So a claim may say what the machine is short of
 * instead (`room`: memory, CPU or both), and with no spacing asked
 * for, the first in line starts as soon as nothing is short and half a
 * minute has passed since the last start: two a minute, so a long line
 * drains no faster than the minute-long averages of pressure can show
 * what the rounds before it took. The line keeps the order rounds were
 * asked in, and its lock makes each start whole.
 *
 * A bar nothing can pass starves the line: from 17:45 on 26 November
 * optimus sat at CPU `some` 40 to 54, past the CPU bar, for hours. So a
 * round held by a bar the reading calls passable, the CPU's alone,
 * starts anyway once it has been held by it for twenty minutes and no
 * round has started for ten (A210E4CA, 26 November): at most one such
 * start each ten minutes, and memory, whose shortage stalls the whole
 * machine, is never passed. The line says what holds it, so a round's
 * place can be read with its reason before it starts.
 *
 * A place once lost was lost for good. A round looks at the line under
 * its lock, and a look that met the lock held past its wait said
 * nothing, so with sixty rounds waiting on 25 November live tickets
 * went unseen for two minutes, were dropped, and joined again at the
 * back: one went from 26th to 53rd in half an hour. So a ticket whose
 * round has stopped looking is passed over rather than dropped, and
 * keeps its place while its process lives, for hours at most. The line
 * is kept in one order, which every look writes back: tickets marked
 * urgent first, then those that lead (World's changes), then by when
 * their change was first asked about, which the line remembers for
 * hours, so a round asked again after a reload takes back its place.
 * A newer ask from the same session for the same change replaces the
 * older one, which ends saying so. A look that would change nothing
 * reads the line without its lock, so only joining, refreshing a
 * sighting, reordering, dropping and starting contend for it.
 *
 * Every start is spaced only once every session on the machine runs
 * this, and only among sessions sharing one state directory. A session
 * on an older install keeps its own fixed slot in `last.json` beside
 * the line; its start is read from the transcripts' newest roster
 * round, which the line spaces from too, and a slot it kept that has
 * already come counts as a start.
 *
 * Long because the line is one record every session on the machine
 * rewrites, so who goes next, how a look reads and writes it under its
 * lock, and how a wait says where it stands all change together when
 * the line's rule does, as reading the file's shape does whenever a
 * ticket learns something new to keep.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isLockHeld, withFileLock } from "../../internal/file-lock.ts";

/** How long after one council starts on a machine before another may. */
export const COUNCIL_START_SPACING_MS = 3 * 60_000;

/**
 * How often a waiting round looks at the line again, at most. Short
 * enough that a dropped ticket ahead of it costs little, long enough
 * that a line of thirty rounds is not a busy loop.
 */
const LOOK_AGAIN_MS = 15_000;

/**
 * The shortest spacing a machine may set. A look that took a start and
 * failed finds it again by its ticket at the next look, at most
 * {@link LOOK_AGAIN_MS} later, as the latest start or the one the latest
 * followed; twice that keeps a second start from coming between, even
 * after a slow look. It also keeps a round waiting behind tickets that
 * never start from reading the line in a tight loop.
 */
export const FEWEST_SPACING_MS = 2 * LOOK_AGAIN_MS;

/**
 * The longest spacing a machine may set, so a mistyped hour holds no
 * round for that hour, even read again at each look as the spacing is.
 */
export const MOST_SPACING_MS = 30 * 60_000;

/**
 * How long a ticket may go unlooked-at before the line passes over it.
 * A waiting round looks every {@link LOOK_AGAIN_MS} at most, so this is
 * many looks missed: a round a reload abandoned, whose process, the
 * session's own, still runs, or one whose looks keep meeting a busy
 * lock. Passed over, it keeps its place for when it looks again, and
 * holds back nobody meanwhile. A ticket seen this far in the future is
 * dropped, as a clock moved back or a line written by hand.
 */
const UNSEEN_TICKET_MS = 2 * 60_000;

/**
 * How long the line keeps what it remembers: a ticket passed over while
 * its process lives, a change's first ask, and a ticket a newer ask
 * replaced. Long enough for a session to reload and ask again, or for a
 * busy lock to let a round look, and short enough that tickets a reload
 * abandoned in a host that runs for days don't pile up.
 */
const REMEMBERED_MS = 6 * 60 * 60_000;

/**
 * How old a ticket's `seenAt` may grow before a look writes it again.
 * A quarter of {@link UNSEEN_TICKET_MS}, so a live round is never
 * dropped, while seventy rounds looking every fifteen seconds no longer
 * rewrite the whole line at every look only to say they are there.
 */
const SEEN_REFRESH_MS = UNSEEN_TICKET_MS / 4;

/** How long a passable bar alone may hold a round before it starts anyway. */
export const PASS_AFTER_MS = 20 * 60_000;

/** How long since the last start before a round may pass a bar. */
export const PASS_SPACING_MS = 10 * 60_000;

/** What keeps a round from starting now, as `room` reads it. */
export interface RoomHeld {
	/** Every reading that is short, with its value and bar, for the answer. */
	readonly said: string;
	/** The names of the readings that are short, for the line to show. */
	readonly readings: readonly string[];
	/** Whether this is a bar a round may pass once it has held long enough. */
	readonly passable: boolean;
}

/**
 * How far ahead a start may lie and still be spaced from. One further
 * ahead than any line of real rounds would reach is a clock that moved
 * back, which would hold every start for as long as it is ahead.
 */
const FURTHEST_START_AHEAD_MS = 2 * 60 * 60_000;

/**
 * How many looks in a row may fail, on a lock held too long or a line
 * that can't be read or written, before the round gives up its place
 * and says why. One failed look is retried at the next, since a lock
 * one session holds a moment too long should not end every round
 * waiting behind it.
 */
const FAILED_LOOKS_AT_MOST = 4;

/** One round's place in the line, as kept on disk. */
interface Ticket {
	/** Its own id, so two rounds of one process are told apart. */
	readonly id: string;
	/** Who asked, as the session. */
	readonly by: string;
	/** What it reads, as a change's label. */
	readonly change: string;
	/** The process waiting, which keeps the ticket only while it lives. */
	readonly pid: number;
	/** When it took its place, in ISO form. */
	readonly askedAt: string;
	/** When its round last looked at the line, in ISO form. */
	readonly seenAt: string;
	/** Whether it stands ahead of asks that don't, as World's changes do. */
	readonly leads?: boolean;
	/**
	 * What kind of round it is, such as a council or a critique, so a
	 * session's newer ask replaces only its own kind. A ticket an older
	 * install wrote has none, and replaces and is replaced by nothing.
	 */
	readonly kind?: string;
}

/** A start that happened, as kept on disk. */
interface Started {
	/** When, in ISO form. */
	readonly at: string;
	/** Who started it. */
	readonly by: string;
	/** What it reads. */
	readonly change: string;
	/** The ticket that took it, so a look that failed after taking it knows. */
	readonly ticket?: string;
	/**
	 * The start it replaced, kept so a look that finds its own start
	 * again can still give it back, rather than leave the line unspaced.
	 */
	readonly follows?: Omit<Started, "follows">;
}

/** The machine's line, as kept on disk. */
interface Line {
	readonly started?: Started;
	readonly waiting: readonly Ticket[];
	/** When each change waiting, or lately waiting, was first asked about. */
	readonly firstAsked?: Readonly<Record<string, string>>;
	/** Tickets a newer ask replaced, with when, so their rounds can end. */
	readonly replaced?: Readonly<Record<string, string>>;
	/** The readings the machine was short of at the last look, if any. */
	readonly heldBy?: readonly string[];
}

/** Who is starting a council now, and on what. */
export interface StartClaim {
	/** The session asking. */
	readonly by: string;
	/** The change it reads, by label. */
	readonly change: string;
	/**
	 * How long after one start another may: {@link COUNCIL_START_SPACING_MS}
	 * unless given, or {@link FEWEST_SPACING_MS} when `room` is given
	 * instead.
	 */
	readonly spacingMs?: number;
	/**
	 * The spacing as configured now, read at each look, so a change to the
	 * config reaches rounds already waiting; `spacingMs` where it says
	 * nothing.
	 */
	readonly spacing?: () => Promise<number | undefined>;
	/**
	 * What keeps a round from starting now, such as memory or CPU, or
	 * nothing when the machine has room. Read at each look.
	 */
	readonly room?: () => Promise<RoomHeld | undefined>;
	/**
	 * How long a passable bar alone may hold a round before it starts
	 * anyway, and how long since the last start it then waits for;
	 * {@link PASS_AFTER_MS} and {@link PASS_SPACING_MS} unless given.
	 */
	readonly pass?: { readonly afterMs: number; readonly spacingMs: number };
	/**
	 * Whether the machine is quiet enough that a round may start one look
	 * after the last, rather than its own spacing. Read at each look, and
	 * only alongside `room` while the spacing is at its floor, since a
	 * wider one set by hand may be for what pressure can't show, such as
	 * a provider's limit; never quiet unless given.
	 */
	readonly quiet?: () => Promise<boolean>;
	/**
	 * The latest start made outside the line, such as a round started by
	 * a session on an older install, read again each time the line is.
	 */
	readonly startedElsewhere?: () => Promise<Date | undefined>;
	/**
	 * Whether this round stands ahead of those that don't, as World's
	 * changes do (1OGSE7, 25 November). Marks only order the line; they
	 * never let a round start sooner than its spacing.
	 */
	readonly leads?: boolean;
	/**
	 * What kind of round asks, such as a council, a stack or a critique.
	 * A newer ask replaces an older one of the same session, change and
	 * kind, never another kind's, which still waits for its own start.
	 */
	readonly kind?: string;
	/**
	 * The tickets and changes marked urgent, which stand first of all,
	 * read at each look. None unless given.
	 */
	readonly urgent?: () => Promise<readonly string[]>;
	/** How often to look at the line again; {@link LOOK_AGAIN_MS} unless given. */
	readonly lookAgainMs?: number;
	/** Whether a process still runs; a real check unless given. */
	readonly alive?: (pid: number) => boolean;
}

/** What a wait for a start answers. */
export interface CouncilStart {
	/** What the round's answer should say about its wait, when it waited. */
	readonly waited?: string;
	/** Why it starts nothing, when it was stopped before or while it waited. */
	readonly cancelled?: string;
	/**
	 * Takes the start back, for a round refused once its wait is over,
	 * so the next round is spaced from the one before it instead.
	 */
	readonly release?: () => Promise<void>;
}

/** Where the line is kept, beside the fixed slot older installs keep at `path`. */
function linePath(path: string): string {
	return join(dirname(path), LINE_FILE);
}

/**
 * Takes a place in the machine's line, kept beside `path`, and waits
 * until it is first and a spacing has passed since the last start,
 * answering what the round's answer should say about the wait, or
 * nothing when it started at once. Stopped by `signal`, before or while
 * it waits, it says so in `cancelled` and leaves the line.
 */
export async function awaitCouncilStart(
	path: string,
	claim: StartClaim,
	signal?: AbortSignal,
): Promise<CouncilStart> {
	if (signal?.aborted === true) {
		return { cancelled: "It was stopped before it took a start." };
	}
	const at = linePath(path);
	await mkdir(dirname(at), { recursive: true });
	const lookAgain = claim.lookAgainMs ?? LOOK_AGAIN_MS;
	// Read at each look; this stands only for a first look that failed.
	let spacings: Spacings = { spacing: 2 * lookAgain, quickest: 2 * lookAgain };
	const asked = new Date().toISOString();
	const ticket: Ticket = {
		// Random rather than counted, since a reload loads this module
		// again in the same process, and two copies would count alike.
		id: randomUUID(),
		by: claim.by,
		change: claim.change,
		pid: process.pid,
		askedAt: asked,
		seenAt: asked,
		...(claim.leads === true ? { leads: true } : {}),
		...(claim.kind === undefined ? {} : { kind: claim.kind }),
	};
	// The first look takes the place, so joining is retried like any look.
	let firstSeen: Turn | undefined;
	let lastShort: string | undefined;
	// Since when only a passable bar has held the machine, by this round's
	// own looks, so a round that joins a line already held so counts from
	// its own first look.
	let passableSince: number | undefined;
	let failed = 0;
	for (;;) {
		let turn: Turn | undefined;
		try {
			spacings = await spacingsNow(claim, lookAgain);
			turn = await takeTurn(at, path, ticket, claim, spacings, passableSince);
			failed = 0;
		} catch (error) {
			// A lock another live round holds past the wait is a busy line,
			// not a broken one: on 24 November a round lost a 42-minute place
			// to it with 67 waiting. Only a line that can't be read or written
			// counts against the round.
			if (!isLockHeld(error)) failed += 1;
			if (failed >= FAILED_LOOKS_AT_MOST) {
				await leave(at, ticket).catch(() => {
					// The line can't be written either; the ticket is dropped
					// by the next reader once this round stops looking.
				});
				throw error;
			}
		}
		if (turn?.replaced === true) {
			// Nothing of its own to leave: the newer ask holds its place.
			return { cancelled: REPLACED_SAID };
		}
		if (turn !== undefined) {
			firstSeen ??= turn;
			passableSince =
				turn.passable === true ? (passableSince ?? turn.lookedAt) : undefined;
		}
		if (turn?.short !== undefined) lastShort = turn.short;
		const started = turn?.started;
		if (turn !== undefined && started !== undefined) {
			const release = () =>
				giveBack(at, ticket, started, turn.before).catch(() => {
					// The start stands as taken; the next round waits a spacing
					// it needn't, which is better than a refused round's caller
					// being cut off partway by a throw.
				});
			if (stoppedBy(signal)) {
				// Given up during the look that took the start: nothing is
				// started in its name, so the start goes back.
				await release();
				return { cancelled: stoppedSaid(firstSeen, spacings, lastShort) };
			}
			const waitedMs = Date.now() - Date.parse(asked);
			const passed = turn.passed === true ? passSaid(claim) : "";
			return firstSeen === undefined || firstSeen.waitMs <= 0
				? { release }
				: {
						waited: `${waitSaid(firstSeen, spacings, waitedMs, lastShort)}${passed}`,
						release,
					};
		}
		try {
			// Room has no time to wait for, so a round held for it looks
			// again at the usual pace rather than at the moment its spacing
			// passed, which it already has.
			await sleep(
				turn?.short === undefined
					? Math.max(1, Math.min(turn?.waitMs ?? lookAgain, lookAgain))
					: lookAgain,
				undefined,
				signal === undefined ? {} : { signal },
			);
		} catch {
			// Only an abort rejects the timer: the round was given up while it
			// waited, which the answer says rather than starting it.
			await leave(at, ticket).catch(() => {
				// The ticket stops being looked at, so the next reader drops it.
			});
			return { cancelled: stoppedSaid(firstSeen, spacings, lastShort) };
		}
	}
}

/**
 * Whether `signal` has been given up. A function, since the narrowing
 * from the check before the wait would otherwise say it never is.
 */
function stoppedBy(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/** What one look at the line found. */
interface Turn {
	/** The start taken, when it was this ticket's turn. */
	readonly started?: Started;
	/** The start it replaced, given back if the round is refused. */
	readonly before?: Started;
	/** How many rounds stand ahead of it, passing over those not looking. */
	readonly ahead: number;
	/** How many rounds the line holds, itself among them, when it waits. */
	readonly of?: number;
	/** Whether a newer ask for its change took its place. */
	readonly replaced?: boolean;
	/** How long until it may start, if those ahead start on time. */
	readonly waitMs: number;
	/** The round first in line, when another is. */
	readonly behind?: { readonly by: string; readonly change: string };
	/** What the machine was short of, when that held it back. */
	readonly short?: string;
	/** Whether what held it, if anything, was a passable bar alone. */
	readonly passable?: boolean;
	/** Whether it started past a passable bar it had been held by long enough. */
	readonly passed?: boolean;
	/** When the look was made, as a time. */
	readonly lookedAt?: number;
}

async function takeTurn(
	at: string,
	path: string,
	ticket: Ticket,
	claim: StartClaim,
	spacings: Spacings,
	passableSince: number | undefined,
): Promise<Turn> {
	const elsewhere = await claim.startedElsewhere?.();
	// Read before the lock, as they may be slow; a round that reads room
	// and then finds another first in line waits its turn all the same.
	const held = await claim.room?.();
	const hurry =
		spacings.quickest < spacings.spacing &&
		held === undefined &&
		(await claim.quiet?.()) === true;
	const spacing = hurry ? spacings.quickest : spacings.spacing;
	const urgent = new Set(await claim.urgent?.());
	const seenFrom = async (line: Line, now: number): Promise<Look> =>
		look(line, {
			ticket,
			now,
			alive: claim.alive ?? isAlive,
			urgent,
			spacing,
			held,
			pass: {
				since: passableSince,
				afterMs: claim.pass?.afterMs ?? PASS_AFTER_MS,
				spacingMs: claim.pass?.spacingMs ?? PASS_SPACING_MS,
			},
			starts: [elsewhere?.getTime(), await oldSlotCome(path, now)],
		});
	// Most looks change nothing: the round is kept, seen lately, in order
	// and not first. Read without the lock, since a line is only ever
	// written whole by a rename, they leave the lock to the looks that
	// write, which sixty rounds looking at once kept from it.
	const peekedAt = Date.now();
	const peeked = await seenFrom(await readLine(at, peekedAt), peekedAt);
	if (peeked.next === undefined) return peeked.turn;
	return withFileLock(at, async () => {
		const now = Date.now();
		const seen = await seenFrom(await readLine(at, now), now);
		if (seen.next !== undefined) await keep(at, seen.next);
		return seen.turn;
	});
}

/** What one look needs beside the line. */
interface LookAt {
	readonly ticket: Ticket;
	readonly now: number;
	readonly alive: (pid: number) => boolean;
	/** Tickets and changes marked urgent. */
	readonly urgent: ReadonlySet<string>;
	readonly spacing: number;
	readonly held: RoomHeld | undefined;
	/** When a passable bar alone began to hold this round, and how long it may. */
	readonly pass: {
		readonly since: number | undefined;
		readonly afterMs: number;
		readonly spacingMs: number;
	};
	/** Starts made outside the line, as times, when there were any. */
	readonly starts: readonly (number | undefined)[];
}

/** What a look found, and the line to write back, when it changed. */
interface Look {
	readonly turn: Turn;
	readonly next?: Line;
}

/**
 * One look at `line` for a round: whether it starts, and the line as it
 * should be kept. Pure, so a look without the lock and one under it
 * judge alike, and only the second writes.
 */
function look(line: Line, at: LookAt): Look {
	const { ticket, now } = at;
	const seen = { lookedAt: now, ...heldTurn(at.held) };
	if (line.started?.follows?.ticket === ticket.id) {
		// An earlier look took the start and failed on its way out, and a
		// quiet machine's next round started one look later: it is
		// started all the same, though no longer the start to give back.
		return {
			turn: {
				started: line.started.follows,
				ahead: 0,
				waitMs: 0,
				lookedAt: now,
			},
		};
	}
	if (line.started?.ticket === ticket.id) {
		// An earlier look took the start and then failed on its way out:
		// it is started, not owed another.
		const { follows } = line.started;
		return {
			turn: {
				started: line.started,
				...(follows === undefined ? {} : { before: follows }),
				ahead: 0,
				waitMs: 0,
				lookedAt: now,
			},
		};
	}
	if (line.replaced?.[ticket.id] !== undefined) {
		return { turn: { ahead: 0, waitMs: 0, replaced: true, lookedAt: now } };
	}
	const replaced = remembered(line.replaced, now);
	const kept = line.waiting.find((each) => each.id === ticket.id);
	const others = line.waiting.filter(
		(each) =>
			each.id !== ticket.id &&
			at.alive(each.pid) &&
			// A ticket seen in the future is a clock moved or a line written
			// by hand, and would otherwise lead the line for as long as its
			// process lives.
			Date.parse(each.seenAt) - now < UNSEEN_TICKET_MS &&
			now - Date.parse(each.seenAt) < REMEMBERED_MS,
	);
	const firstAsked = remembered(line.firstAsked, now);
	let mine: Ticket;
	let still = others;
	if (kept === undefined) {
		// Joining, or joining again after a reader that kept the old rule
		// dropped it: placed by when its change was first asked about, and
		// in place of an older ask of this session's for the same change and
		// kind. A critique leaves the same session's council waiting.
		const older = others.filter(
			(each) =>
				each.by === ticket.by &&
				each.change === ticket.change &&
				each.kind !== undefined &&
				each.kind === ticket.kind,
		);
		for (const each of older) replaced[each.id] = new Date(now).toISOString();
		still = others.filter((each) => !older.includes(each));
		const askedAt = earliest([
			ticket.askedAt,
			firstAsked[ticket.change],
			...older.map((each) => each.askedAt),
		]);
		mine = { ...ticket, askedAt, seenAt: new Date(now).toISOString() };
	} else {
		mine =
			Math.abs(now - Date.parse(kept.seenAt)) >= SEEN_REFRESH_MS
				? { ...kept, seenAt: new Date(now).toISOString() }
				: kept;
	}
	const waiting = inOrder([...still, mine], at.urgent);
	const holding = waiting.filter(
		(each) =>
			each.id === ticket.id ||
			Math.abs(now - Date.parse(each.seenAt)) < UNSEEN_TICKET_MS,
	);
	const ahead = holding.findIndex((each) => each.id === ticket.id);
	const last = Math.max(
		...[
			line.started === undefined ? undefined : Date.parse(line.started.at),
			...at.starts,
		].filter(
			(start): start is number =>
				start !== undefined &&
				Number.isFinite(start) &&
				start - now <= FURTHEST_START_AHEAD_MS,
		),
		Number.NEGATIVE_INFINITY,
	);
	const free = last + at.spacing;
	// Held by a passable bar alone for long enough, it starts once no
	// round has started for the pass's spacing, as the head says.
	const passes =
		at.held?.passable === true &&
		at.pass.since !== undefined &&
		now - at.pass.since >= at.pass.afterMs &&
		now >= last + Math.max(at.spacing, at.pass.spacingMs);
	if (ahead === 0 && now >= free && (at.held === undefined || passes)) {
		const before = withoutFollows(line.started);
		const started: Started = {
			at: new Date(now).toISOString(),
			by: ticket.by,
			change: ticket.change,
			ticket: ticket.id,
			...(before === undefined ? {} : { follows: before }),
		};
		const left = waiting.filter((each) => each.id !== ticket.id);
		// Its change has had its start, so an ask after this one takes its
		// own place rather than this one's.
		const { [ticket.change]: _started, ...asked } = firstAsked;
		return {
			turn: {
				started,
				...(before === undefined ? {} : { before }),
				ahead: 0,
				waitMs: 0,
				...seen,
				...(passes ? { passed: true } : {}),
			},
			next: remembering(
				{ started, waiting: left, ...heldLine(at.held) },
				asked,
				replaced,
			),
		};
	}
	const next = remembering(
		{
			...(line.started === undefined ? {} : { started: line.started }),
			waiting,
			...heldLine(at.held),
		},
		firstAsked,
		replaced,
	);
	const first = holding[0];
	return {
		turn: {
			ahead,
			of: holding.length,
			// Room has no time to wait for, so a round held for it waits at
			// least a moment, which says it waited.
			waitMs: Math.max(
				Math.max(free, now) + ahead * at.spacing - now,
				ahead > 0 || at.held !== undefined ? 1 : 0,
			),
			...(ahead > 0 && first !== undefined
				? { behind: { by: first.by, change: first.change } }
				: {}),
			...seen,
		},
		// Only a change is written: a ticket joining, one dropped or moved,
		// or a sighting old enough to need saying again.
		...(sameLine(next, line) ? {} : { next }),
	};
}

/** What a look says of the machine's hold on it. */
function heldTurn(
	held: RoomHeld | undefined,
): Pick<Turn, "short" | "passable"> {
	return held === undefined
		? {}
		: { short: held.said, ...(held.passable ? { passable: true } : {}) };
}

/**
 * What the line keeps of the machine's hold: the readings' names only,
 * which change seldom, so a look whose figures moved writes nothing.
 */
function heldLine(held: RoomHeld | undefined): Pick<Line, "heldBy"> {
	return held === undefined ? {} : { heldBy: held.readings };
}

/**
 * The line with what it remembers: each waiting change's first ask,
 * folded into those remembered, and the tickets lately replaced.
 */
function remembering(
	line: Pick<Line, "started" | "waiting" | "heldBy">,
	firstAsked: Record<string, string>,
	replaced: Record<string, string>,
): Line {
	const asked = { ...firstAsked };
	for (const each of line.waiting) {
		asked[each.change] = earliest([each.askedAt, asked[each.change]]);
	}
	return {
		...line,
		...(Object.keys(asked).length === 0 ? {} : { firstAsked: asked }),
		...(Object.keys(replaced).length === 0 ? {} : { replaced }),
	};
}

/** What `record` holds from the last {@link REMEMBERED_MS}, as a copy. */
function remembered(
	record: Readonly<Record<string, string>> | undefined,
	now: number,
): Record<string, string> {
	const kept: Record<string, string> = {};
	for (const [key, when] of Object.entries(record ?? {})) {
		const age = now - Date.parse(when);
		if (age < REMEMBERED_MS && age > -REMEMBERED_MS) kept[key] = when;
	}
	return kept;
}

/** The earliest of some ISO times, the first given when none is earlier. */
function earliest(times: readonly (string | undefined)[]): string {
	let first: string | undefined;
	for (const each of times) {
		if (each === undefined || !Number.isFinite(Date.parse(each))) continue;
		if (first === undefined || Date.parse(each) < Date.parse(first)) {
			first = each;
		}
	}
	return first ?? new Date().toISOString();
}

/**
 * The line's one order: urgent first, then those that lead, then by
 * when each was first asked about, then by id, so every look orders
 * the same tickets the same way, whoever is looking.
 */
function inOrder(
	waiting: readonly Ticket[],
	urgent: ReadonlySet<string>,
): Ticket[] {
	const rank = (each: Ticket): number => {
		if (urgent.has(each.id) || urgent.has(each.change)) return 0;
		return leads(each) ? 1 : 2;
	};
	// Two asks in one millisecond fall to their ids, so every look agrees
	// which is ahead rather than each seeing the other first.
	return [...waiting].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			Date.parse(a.askedAt) - Date.parse(b.askedAt) ||
			byId(a, b),
	);
}

/** Orders two tickets by id alone, the same way on every look. */
function byId(a: Ticket, b: Ticket): number {
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}

/**
 * Whether a ticket leads: marked so by its round, or, for a round on an
 * install that marks nothing, a change World hosts.
 */
function leads(ticket: Ticket): boolean {
	return ticket.leads === true || hostedByWorld(ticket.change);
}

/**
 * Whether a change's label names a change World hosts, as
 * `shop/world#2535422` does, and not a label that merely holds the
 * words, such as a checkout's path.
 */
export function hostedByWorld(change: string): boolean {
	return /^(?:[\w.-]+:)?shop\/world#\d+$/.test(change);
}

/** Whether two lines would be kept alike. */
function sameLine(a: Line, b: Line): boolean {
	return JSON.stringify(normal(a)) === JSON.stringify(normal(b));
}

/** A line with only what it keeps, in the order `keep` writes it. */
function normal(line: Line): Line {
	return {
		...(line.started === undefined ? {} : { started: line.started }),
		waiting: line.waiting,
		...(line.firstAsked === undefined ? {} : { firstAsked: line.firstAsked }),
		...(line.replaced === undefined ? {} : { replaced: line.replaced }),
		...(line.heldBy === undefined ? {} : { heldBy: line.heldBy }),
	};
}

/** A start without the one it replaced, so the line never nests deeper. */
function withoutFollows(
	started: Started | undefined,
): Omit<Started, "follows"> | undefined {
	if (started === undefined) return undefined;
	const { follows: _replaced, ...rest } = started;
	return rest;
}

/**
 * Takes `ticket` out of the line, as a round given up while it waits,
 * along with any start a look took in its name and failed to answer:
 * nothing starts for it, so the start before goes back.
 */
async function leave(at: string, ticket: Ticket): Promise<void> {
	await withFileLock(at, async () => {
		const line = await readLine(at);
		const waiting = line.waiting.filter((each) => each.id !== ticket.id);
		const started =
			line.started?.ticket === ticket.id ? line.started.follows : line.started;
		const { started: _was, ...rest } = line;
		await keep(
			at,
			started === undefined
				? { ...rest, waiting }
				: { ...rest, started, waiting },
		);
	});
}

/**
 * Takes back a start for a round refused once its wait was over,
 * putting back the one before it while this is still the last, so the
 * next round is not held a spacing behind a start that never happened.
 */
async function giveBack(
	at: string,
	ticket: Ticket,
	started: Started | undefined,
	before: Started | undefined,
): Promise<void> {
	await withFileLock(at, async () => {
		const line = await readLine(at);
		const ours =
			started !== undefined &&
			line.started?.at === started.at &&
			line.started.ticket === ticket.id;
		if (!ours) return;
		const { started: _taken, ...rest } = line;
		await keep(at, before === undefined ? rest : { ...rest, started: before });
	});
}

/**
 * When the fixed slot an older install kept at `path` starts, if it has
 * come: that round has started, or is about to. One still to come is
 * left to start on its own, since spacing from it would put every
 * round in the line behind the gaps this replaces.
 */
async function oldSlotCome(
	path: string,
	now: number,
): Promise<number | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		// No older install kept a slot: nothing to space from.
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("startAt" in parsed) ||
			typeof parsed.startAt !== "string"
		) {
			return undefined;
		}
		const at = Date.parse(parsed.startAt);
		return Number.isFinite(at) && at <= now ? at : undefined;
	} catch {
		// Cut short or overwritten by hand: nothing to space from.
		return undefined;
	}
}

async function keep(at: string, line: Line): Promise<void> {
	const next = `${at}.${process.pid}.tmp`;
	await writeFile(next, `${JSON.stringify(line)}\n`);
	await rename(next, at);
}

/**
 * The line kept at `at`: empty when none is, and spaced from `now` when
 * what is there can't be read or isn't a line.
 */
async function readLine(at: string, now = Date.now()): Promise<Line> {
	// A line that can't be read or parsed lost whatever it held, its last
	// start among them. Spacing from now, as though one had just started,
	// keeps it from letting the next round start unspaced, and the look
	// that reads it writes a whole line over it, so it heals rather than
	// failing every round on the machine.
	const garbled: Line = {
		started: {
			at: new Date(now).toISOString(),
			by: "an unreadable line",
			change: "an unreadable line",
		},
		waiting: [],
	};
	let text: string;
	try {
		text = await readFile(at, "utf8");
	} catch (error) {
		if (isMissing(error)) return { waiting: [] };
		// A machine short of descriptors or a disk that hiccupped may read
		// the line whole at the next look; writing over it now would lose
		// its waiters and its start, so the look fails and is retried.
		if (isPassing(error)) throw error;
		return garbled;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		// Every line kept here holds a waiting list; anything else, `{}` or a
		// start that isn't one among them, is not a line this wrote.
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("waiting" in parsed) ||
			!Array.isArray(parsed.waiting) ||
			("started" in parsed && !isStarted(parsed.started))
		) {
			return garbled;
		}
		const started =
			"started" in parsed && isStarted(parsed.started)
				? parsed.started
				: undefined;
		const waiting = parsed.waiting.filter(isTicket);
		const firstAsked =
			"firstAsked" in parsed ? timesIn(parsed.firstAsked) : undefined;
		const replaced =
			"replaced" in parsed ? timesIn(parsed.replaced) : undefined;
		const heldBy =
			"heldBy" in parsed && Array.isArray(parsed.heldBy)
				? parsed.heldBy.filter((each) => typeof each === "string")
				: undefined;
		return {
			...(started === undefined ? {} : { started }),
			waiting,
			...(firstAsked === undefined ? {} : { firstAsked }),
			...(replaced === undefined ? {} : { replaced }),
			...(heldBy === undefined ? {} : { heldBy }),
		};
	} catch {
		// Cut short or overwritten by hand: spaced from now.
		return garbled;
	}
}

/**
 * Read errors that say nothing about the line, only about this moment:
 * a process or machine short of descriptors, or a call interrupted. EIO
 * and EBUSY are left out, since a disk or mount that answers so often
 * goes on answering so, and a line that can never be read must heal
 * rather than fail every round on the machine.
 */
const PASSING_READ_ERRORS: ReadonlySet<string> = new Set([
	"EMFILE",
	"ENFILE",
	"EAGAIN",
	"EINTR",
]);

/** Whether a read failed for a reason the next look may not meet. */
function isPassing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string" &&
		PASSING_READ_ERRORS.has(error.code)
	);
}

/** Whether a read failed only because nothing is kept there yet. */
function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

/**
 * The times a record kept in the line names, by key, leaving out any
 * that isn't one; nothing when it holds none, or isn't a record.
 */
function timesIn(value: unknown): Record<string, string> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const times: Record<string, string> = {};
	for (const [key, when] of Object.entries(value)) {
		if (typeof when === "string" && Number.isFinite(Date.parse(when))) {
			times[key] = when;
		}
	}
	return Object.keys(times).length === 0 ? undefined : times;
}

function isStarted(value: unknown): value is Started {
	return (
		typeof value === "object" &&
		value !== null &&
		"at" in value &&
		typeof value.at === "string" &&
		Number.isFinite(Date.parse(value.at)) &&
		"by" in value &&
		typeof value.by === "string" &&
		"change" in value &&
		typeof value.change === "string" &&
		(!("ticket" in value) || typeof value.ticket === "string") &&
		(!("follows" in value) || isStarted(value.follows))
	);
}

function isTicket(value: unknown): value is Ticket {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"by" in value &&
		typeof value.by === "string" &&
		"change" in value &&
		typeof value.change === "string" &&
		"pid" in value &&
		typeof value.pid === "number" &&
		"askedAt" in value &&
		typeof value.askedAt === "string" &&
		Number.isFinite(Date.parse(value.askedAt)) &&
		"seenAt" in value &&
		typeof value.seenAt === "string" &&
		Number.isFinite(Date.parse(value.seenAt)) &&
		(!("leads" in value) || typeof value.leads === "boolean") &&
		(!("kind" in value) || typeof value.kind === "string")
	);
}

/** Whether a process with `pid` runs on this machine. */
function isAlive(pid: number): boolean {
	// Zero and below name a process group to kill(2), never one process.
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it runs under another user, which still counts as
		// running; only ESRCH says nothing holds the id.
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "EPERM"
		);
	}
}

/**
 * When the newest roster round in `folder` started, read from the
 * folder names reviewers leave their transcripts under, such as
 * `council-20261122T174622008-000002`, or nothing when none is there.
 * A judge and an audit are not counted: each asks one participant. A
 * reviewer's retry leaves a `council-` folder too, which counts, so a
 * start after one may wait a spacing it needn't.
 */
export async function newestRosterStartIn(
	folder: string,
): Promise<Date | undefined> {
	let names: string[];
	try {
		names = await readdir(folder);
	} catch {
		// No round has left transcripts yet: no start to space from.
		return undefined;
	}
	let newest: number | undefined;
	for (const name of names) {
		const at = rosterStartOf(name);
		if (at !== undefined && (newest === undefined || at > newest)) newest = at;
	}
	return newest === undefined ? undefined : new Date(newest);
}

const ROSTER_RUN =
	/^(?:council|stack|critique)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})-\d+$/;

/**
 * When the roster round a transcripts folder is named for started, in
 * milliseconds, or nothing when the name is no roster round's.
 */
export function rosterStartOf(name: string): number | undefined {
	const parts = ROSTER_RUN.exec(name);
	if (parts === null) return undefined;
	const [, y, mo, d, h, mi, s, ms] = parts;
	const at = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
	return Number.isFinite(at) ? at : undefined;
}

/** Longest name read from the shared line that an answer repeats. */
const NAME_SAID_AT_MOST = 120;

/** Another session wrote it, so the answer repeats only so much of it. */
function bounded(name: string): string {
	return name.length <= NAME_SAID_AT_MOST
		? name
		: `${name.slice(0, NAME_SAID_AT_MOST)}...`;
}

/** A round's spacing, and the quicker one it takes while the machine is quiet. */
interface Spacings {
	readonly spacing: number;
	readonly quickest: number;
}

/**
 * The spacings a look goes by, the config read as it stands now.
 *
 * Never under two looks, whoever asks: the line's own guard against a
 * failed look losing its start, and against a tight loop, holds here
 * rather than only in whichever reader of a config remembered it.
 * Started on room, that floor is the spacing: two starts a minute, so a
 * long line drains no faster than the minute-long averages of memory
 * and CPU pressure can show what the rounds before took, and a machine
 * with no reading of pressure still starts no burst.
 *
 * A quiet machine, well inside every bar, may start one look after the
 * last instead, fifteen seconds in production (A210E4CA, 27 November):
 * its live MemAvailable still stops a burst the averages are slow to
 * show. A round that took a start and failed still finds it one start
 * back. Only while the spacing is at its floor, which a config setting
 * none or as often as it can leaves it at, and only for a claim that
 * reads quiet at all, so a wait never names a pace it can't take.
 */
async function spacingsNow(
	claim: StartClaim,
	lookAgain: number,
): Promise<Spacings> {
	const given = (await claim.spacing?.()) ?? claim.spacingMs;
	const floor = 2 * lookAgain;
	const spacing = Math.max(
		given ?? (claim.room === undefined ? COUNCIL_START_SPACING_MS : 0),
		floor,
	);
	// Quiet is a pace inside the bars, never one without them, and only
	// for a spacing at the floor, which asks for as often as it can.
	const mayHurry =
		claim.quiet !== undefined && claim.room !== undefined && spacing <= floor;
	return {
		spacing,
		quickest: mayHurry ? Math.min(spacing, lookAgain) : spacing,
	};
}

function waitSaid(
	turn: Turn,
	spacing: Spacings,
	waitedMs: number,
	short: string | undefined,
): string {
	return `It waited ${minutesSaid(waitedMs)} for its start, ${placeSaid(turn)}, since ${startRuleSaid(spacing, short)}. The line is ${LINE_FILE} beside the council-starts state; a ticket whose round stops looking is passed over after ${UNSEEN_TICKET_MS / 60_000} minutes and keeps its place.`;
}

/** What a round that passed a bar adds to what its wait says. */
function passSaid(claim: StartClaim): string {
	const after = claim.pass?.afterMs ?? PASS_AFTER_MS;
	const spacing = claim.pass?.spacingMs ?? PASS_SPACING_MS;
	return ` It started past the CPU bar, which alone had held it for ${spacingSaid(after)}, with no round started for ${spacingSaid(spacing)}.`;
}

/** What a round replaced by a newer ask for its change answers. */
const REPLACED_SAID =
	"It was replaced by a newer ask for this change, which keeps its place in the start line, so nothing was started.";

/** One round waiting in the line, as `placesInLine` answers. */
export interface LinePlace {
	/** Its place among the rounds the line holds back for, from 1. */
	readonly position: number;
	/** How many rounds the line holds back for. */
	readonly of: number;
	/** Who asked, as the session. */
	readonly by: string;
	/** When its change was first asked about, in ISO form. */
	readonly askedAt: string;
	/** The readings the machine was short of at the line's last look. */
	readonly heldBy?: readonly string[];
}

/**
 * Where the rounds on `change` stand in the machine's line kept beside
 * `path`, read without its lock, as `runs` says it. A round that has
 * stopped looking is left out, as the line passes over it.
 */
export async function placesInLine(
	path: string,
	change: string,
	now = Date.now(),
): Promise<LinePlace[]> {
	let line: Line;
	try {
		line = await readLine(linePath(path), now);
	} catch {
		// A line that can't be read this moment holds nobody it can name.
		return [];
	}
	const holding = line.waiting.filter(
		(each) => Math.abs(now - Date.parse(each.seenAt)) < UNSEEN_TICKET_MS,
	);
	return holding.flatMap((each, place) =>
		each.change === change
			? [
					{
						position: place + 1,
						of: holding.length,
						by: each.by,
						askedAt: each.askedAt,
						...(line.heldBy === undefined ? {} : { heldBy: line.heldBy }),
					},
				]
			: [],
	);
}

/** The line's file name, said so a person can find a wedged line. */
const LINE_FILE = "line.json";

/** A spacing as a person would say it: whole minutes, else seconds. */
function spacingSaid(ms: number): string {
	const minutes = ms / 60_000;
	if (Number.isInteger(minutes)) {
		return minutes === 1 ? "minute" : `${minutes} minutes`;
	}
	const seconds = Math.round(ms / 1000);
	return seconds === 1 ? "second" : `${seconds} seconds`;
}

function minutesSaid(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "under a minute";
	return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function stoppedSaid(
	turn: Turn | undefined,
	spacing: Spacings,
	short: string | undefined,
): string {
	const where = turn === undefined ? "" : `, ${placeSaid(turn)},`;
	return `It was stopped while it waited for its start${where}, so nothing was started, since ${startRuleSaid(spacing, short)}.`;
}

/** When a round starts here, and what held it, as its answer says. */
function startRuleSaid(
	{ spacing, quickest }: Spacings,
	short: string | undefined,
): string {
	const quiet =
		quickest < spacing
			? `, or each ${spacingSaid(quickest)} while it is quiet`
			: "";
	const rule = `one roster round starts on this machine each ${spacingSaid(spacing)}${quiet}, while the machine has room`;
	return short === undefined ? rule : `${rule}, and while it waited ${short}`;
}

function placeSaid(turn: Turn): string {
	const behind =
		turn.behind === undefined
			? ""
			: `, behind ${bounded(turn.behind.change)} (asked by ${bounded(turn.behind.by)})`;
	const place =
		turn.ahead === 0
			? "next in line"
			: `${turn.ahead} ${turn.ahead === 1 ? "round" : "rounds"} ahead`;
	const position =
		turn.of === undefined
			? ""
			: `, position ${turn.ahead + 1} of ${turn.of} in the start line`;
	return `${place}${behind}${position}`;
}
