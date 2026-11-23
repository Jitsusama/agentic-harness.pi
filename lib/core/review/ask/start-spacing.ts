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
 * How long a ticket may go unlooked-at before it is taken for one its
 * round left behind. A waiting round looks every {@link LOOK_AGAIN_MS}
 * at most, so this is many looks missed. It is what drops a round a
 * reload abandoned, whose process, the session's own, still runs.
 */
const UNSEEN_TICKET_MS = 2 * 60_000;

/**
 * How far ahead a start may lie and still be spaced from. One further
 * ahead than any line of real rounds would reach is a clock that moved
 * back, which would hold every start for as long as it is ahead.
 */
const FURTHEST_START_AHEAD_MS = 2 * 60 * 60_000;

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
	/** This process's id; `process.pid` unless given. */
	readonly pid?: number;
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
	return join(dirname(path), "line.json");
}

let ticketsTaken = 0;

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
	const spacing = claim.spacingMs ?? COUNCIL_START_SPACING_MS;
	const lookAgain = claim.lookAgainMs ?? LOOK_AGAIN_MS;
	ticketsTaken += 1;
	const asked = new Date().toISOString();
	const ticket: Ticket = {
		id: `${claim.pid ?? process.pid}-${Date.now()}-${ticketsTaken}`,
		by: claim.by,
		change: claim.change,
		pid: claim.pid ?? process.pid,
		askedAt: asked,
		seenAt: asked,
	};
	await withFileLock(at, async () => {
		const line = await readLine(at);
		await keep(at, { ...line, waiting: [...line.waiting, ticket] });
	});
	let firstSeen: Turn | undefined;
	for (;;) {
		const turn = await takeTurn(at, path, ticket, claim, spacing);
		firstSeen ??= turn;
		if (turn.started !== undefined) {
			const release = () => giveBack(at, ticket, turn.started, turn.before);
			return firstSeen.waitMs <= 0
				? { release }
				: { waited: waitSaid(firstSeen, spacing), release };
		}
		try {
			await sleep(
				Math.max(1, Math.min(turn.waitMs, lookAgain)),
				undefined,
				signal === undefined ? {} : { signal },
			);
		} catch {
			// Only an abort rejects the timer: the round was given up while it
			// waited, which the answer says rather than starting it.
			await leave(at, ticket);
			return { cancelled: stoppedSaid(firstSeen, spacing) };
		}
	}
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
		const line = await readLine(at);
		const seen = { ...ticket, seenAt: new Date(now).toISOString() };
		const waiting = line.waiting
			.filter(
				(each) =>
					each.id === ticket.id ||
					(alive(each.pid) && now - Date.parse(each.seenAt) < UNSEEN_TICKET_MS),
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
			const started: Started = {
				at: new Date(now).toISOString(),
				by: ticket.by,
				change: ticket.change,
			};
			await keep(at, {
				started,
				waiting: mine.filter((each) => each.id !== ticket.id),
			});
			return {
				started,
				...(line.started === undefined ? {} : { before: line.started }),
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

/** Takes `ticket` out of the line, as a round given up while it waits. */
async function leave(at: string, ticket: Ticket): Promise<void> {
	await withFileLock(at, async () => {
		const line = await readLine(at);
		await keep(at, {
			...line,
			waiting: line.waiting.filter((each) => each.id !== ticket.id),
		});
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
			line.started.by === ticket.by &&
			line.started.change === ticket.change;
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

/** The line kept at `at`, or an empty one when none is or it can't be read. */
async function readLine(at: string): Promise<Line> {
	let text: string;
	try {
		text = await readFile(at, "utf8");
	} catch {
		// None kept yet, or unreadable: nobody waits.
		return { waiting: [] };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return { waiting: [] };
		const started =
			"started" in parsed && isStarted(parsed.started)
				? parsed.started
				: undefined;
		const waiting =
			"waiting" in parsed && Array.isArray(parsed.waiting)
				? parsed.waiting.filter(isTicket)
				: [];
		return started === undefined ? { waiting } : { started, waiting };
	} catch {
		// Cut short or overwritten by hand: nobody waits.
		return { waiting: [] };
	}
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
		typeof value.change === "string"
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

function waitSaid(turn: Turn, spacing: number): string {
	return `It waited for its start ${placeSaid(turn)}, since one roster round starts on this machine each ${spacing / 60_000} minutes.`;
}

function stoppedSaid(turn: Turn | undefined, spacing: number): string {
	const where = turn === undefined ? "" : ` ${placeSaid(turn)}`;
	return `It was stopped while it waited for its start${where}, so nothing was started. One roster round starts on this machine each ${spacing / 60_000} minutes.`;
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
