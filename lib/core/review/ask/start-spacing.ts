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
 * Every start is spaced only once every session on the machine runs
 * this, and only among sessions sharing one state directory. A session
 * on an older install keeps its own fixed slot in `last.json` beside
 * the line; its start is read from the transcripts' newest roster
 * round, which the line spaces from too, and a slot it kept that has
 * already come counts as a start.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { withFileLock } from "../../internal/file-lock.ts";

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
 * {@link LOOK_AGAIN_MS} later, which only works while no other round
 * may yet start after it; twice that leaves room for a slow look. It
 * also keeps a round waiting behind tickets that never start from
 * reading the line in a tight loop.
 */
export const FEWEST_SPACING_MS = 2 * LOOK_AGAIN_MS;

/**
 * The longest spacing a machine may set. A round reads the spacing once,
 * when it asks, so a mistyped hour would hold it for that hour even
 * after the config was put right.
 */
export const MOST_SPACING_MS = 30 * 60_000;

/**
 * How long a ticket may go unlooked-at before it is taken for one its
 * round left behind. A waiting round looks every {@link LOOK_AGAIN_MS}
 * at most, so this is many looks missed. It is what drops a round a
 * reload abandoned, whose process, the session's own, still runs. A
 * ticket seen this far in the future is dropped too, as a clock moved
 * back or a line written by hand.
 */
const UNSEEN_TICKET_MS = 2 * 60_000;

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
}

/** Who is starting a council now, and on what. */
export interface StartClaim {
	/** The session asking. */
	readonly by: string;
	/** The change it reads, by label. */
	readonly change: string;
	/** How long after one start another may; {@link COUNCIL_START_SPACING_MS} unless given. */
	readonly spacingMs?: number;
	/**
	 * The latest start made outside the line, such as a round started by
	 * a session on an older install, read again each time the line is.
	 */
	readonly startedElsewhere?: () => Promise<Date | undefined>;
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
	// Never under two looks, whoever asks: the line's own guard against a
	// failed look losing its start, and against a tight loop, holds here
	// rather than only in whichever reader of a config remembered it.
	const spacing = Math.max(
		claim.spacingMs ?? COUNCIL_START_SPACING_MS,
		2 * lookAgain,
	);
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
	};
	// The first look takes the place, so joining is retried like any look.
	let firstSeen: Turn | undefined;
	let failed = 0;
	for (;;) {
		let turn: Turn | undefined;
		try {
			turn = await takeTurn(at, path, ticket, claim, spacing);
			failed = 0;
		} catch (error) {
			failed += 1;
			if (failed >= FAILED_LOOKS_AT_MOST) {
				await leave(at, ticket).catch(() => {
					// The line can't be written either; the ticket is dropped
					// by the next reader once this round stops looking.
				});
				throw error;
			}
		}
		if (turn !== undefined) firstSeen ??= turn;
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
				return { cancelled: stoppedSaid(firstSeen, spacing) };
			}
			const waitedMs = Date.now() - Date.parse(asked);
			return firstSeen === undefined || firstSeen.waitMs <= 0
				? { release }
				: { waited: waitSaid(firstSeen, spacing, waitedMs), release };
		}
		try {
			await sleep(
				Math.max(1, Math.min(turn?.waitMs ?? lookAgain, lookAgain)),
				undefined,
				signal === undefined ? {} : { signal },
			);
		} catch {
			// Only an abort rejects the timer: the round was given up while it
			// waited, which the answer says rather than starting it.
			await leave(at, ticket).catch(() => {
				// The ticket stops being looked at, so the next reader drops it.
			});
			return { cancelled: stoppedSaid(firstSeen, spacing) };
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
	/** How many rounds stand ahead of it. */
	readonly ahead: number;
	/** How long until it may start, if those ahead start on time. */
	readonly waitMs: number;
	/** The round first in line, when another is. */
	readonly behind?: { readonly by: string; readonly change: string };
}

async function takeTurn(
	at: string,
	path: string,
	ticket: Ticket,
	claim: StartClaim,
	spacing: number,
): Promise<Turn> {
	const elsewhere = await claim.startedElsewhere?.();
	return withFileLock(at, async () => {
		const now = Date.now();
		const alive = claim.alive ?? isAlive;
		const line = await readLine(at, now);
		if (line.started?.ticket === ticket.id) {
			// An earlier look took the start and then failed on its way out:
			// it is started, not owed another.
			const { follows } = line.started;
			return {
				started: line.started,
				...(follows === undefined ? {} : { before: follows }),
				ahead: 0,
				waitMs: 0,
			};
		}
		const seen = { ...ticket, seenAt: new Date(now).toISOString() };
		const waiting = line.waiting
			.filter(
				(each) =>
					each.id === ticket.id ||
					(alive(each.pid) &&
						// Either way: a ticket seen in the future is a clock moved
						// or a line written by hand, and would otherwise hold
						// every round for as long as its process lives.
						Math.abs(now - Date.parse(each.seenAt)) < UNSEEN_TICKET_MS),
			)
			.map((each) => (each.id === ticket.id ? seen : each));
		const place = waiting.findIndex((each) => each.id === ticket.id);
		const mine = place < 0 ? [...waiting, seen] : waiting;
		const ahead = place < 0 ? waiting.length : place;
		const last = Math.max(
			...[
				line.started === undefined ? undefined : Date.parse(line.started.at),
				elsewhere?.getTime(),
				await oldSlotCome(path, now),
			].filter(
				(start): start is number =>
					start !== undefined &&
					Number.isFinite(start) &&
					start - now <= FURTHEST_START_AHEAD_MS,
			),
			Number.NEGATIVE_INFINITY,
		);
		const free = last + spacing;
		if (ahead === 0 && now >= free) {
			const replaced = withoutFollows(line.started);
			const started: Started = {
				at: new Date(now).toISOString(),
				by: ticket.by,
				change: ticket.change,
				ticket: ticket.id,
				...(replaced === undefined ? {} : { follows: replaced }),
			};
			await keep(at, {
				started,
				waiting: mine.filter((each) => each.id !== ticket.id),
			});
			return {
				started,
				...(replaced === undefined ? {} : { before: replaced }),
				ahead: 0,
				waitMs: 0,
			};
		}
		await keep(at, { ...line, waiting: mine });
		const first = mine[0];
		return {
			ahead,
			waitMs: Math.max(free, now) + ahead * spacing - now,
			...(ahead > 0 && first !== undefined
				? { behind: { by: first.by, change: first.change } }
				: {}),
		};
	});
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
		await keep(at, started === undefined ? { waiting } : { started, waiting });
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
		await keep(
			at,
			before === undefined
				? { waiting: line.waiting }
				: { started: before, waiting: line.waiting },
		);
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
		return started === undefined ? { waiting } : { started, waiting };
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
		Number.isFinite(Date.parse(value.seenAt))
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

function rosterStartOf(name: string): number | undefined {
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

function waitSaid(turn: Turn, spacing: number, waitedMs: number): string {
	return `It waited ${minutesSaid(waitedMs)} for its start, ${placeSaid(turn)}, since one roster round starts on this machine each ${spacingSaid(spacing)}. The line is ${LINE_FILE} beside the council-starts state; a ticket whose round is gone drops out within ${UNSEEN_TICKET_MS / 60_000} minutes.`;
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

function stoppedSaid(turn: Turn | undefined, spacing: number): string {
	const where = turn === undefined ? "" : `, ${placeSaid(turn)},`;
	return `It was stopped while it waited for its start${where}, so nothing was started. One roster round starts on this machine each ${spacingSaid(spacing)}.`;
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
	return `${place}${behind}`;
}
