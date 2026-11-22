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
 * win. So each start takes the next free slot instead: under a lock
 * every session on the machine takes, it reads the slot the last one
 * took, takes the one a spacing after it (or now, when that has
 * passed), and keeps it as the new last. The caller waits for its slot,
 * saying its place and when it starts. A round given up while it waits
 * gives its slot back while it is still the last; behind a later claim
 * it leaves a gap.
 *
 * Every start is spaced only once every session on the machine runs
 * this, and only among sessions sharing one state directory; until
 * then the transcripts' newest roster round stands in for the rest.
 */

import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { withFileLock } from "../../internal/file-lock.ts";

/** How long after one council starts on a machine before another may. */
export const COUNCIL_START_SPACING_MS = 3 * 60_000;

/**
 * How far ahead a kept slot may lie and still be waited behind. A slot
 * further ahead than any queue of real rounds would reach is a clock
 * that moved back, which would hold every start for as long as it is
 * ahead.
 */
const FURTHEST_SLOT_AHEAD_MS = 2 * 60 * 60_000;

/**
 * How soon after a kept slot a round's transcripts folder may be
 * stamped and still be that round's own: it is written as the round
 * opens, a moment after its wait ends.
 */
const SAME_ROUND_WITHIN_MS = 30_000;

/** The last slot taken on the machine, as kept on disk. */
interface KeptSlot {
	/** When it starts, in ISO form. */
	readonly startAt: string;
	/** Who took it, as the session that asked. */
	readonly by: string;
	/** What it reads, as a change's label. */
	readonly change: string;
}

/** Who is starting a council now, and on what. */
export interface StartClaim {
	/** The session asking. */
	readonly by: string;
	/** The change it reads, by label. */
	readonly change: string;
	/** Now, by the clock starts are measured on. */
	readonly now: Date;
	/** How long after one start another may; {@link COUNCIL_START_SPACING_MS} unless given. */
	readonly spacingMs?: number;
	/**
	 * The latest start made without taking a slot, such as a round
	 * started by a session on an install older than this, which the
	 * slot also keeps its spacing from.
	 */
	readonly startedElsewhereAt?: Date;
}

/** The slot a claim was given. */
export interface StartSlot {
	/** When the round may start: now, or a spacing after the one before. */
	readonly startAt: Date;
	/**
	 * How many rounds still to start come before it: 0 when it starts
	 * now or next.
	 */
	readonly ahead: number;
	/** The start it waits behind, when it waits. */
	readonly behind?: { readonly by: string; readonly change: string };
}

/**
 * Takes the machine's next council start, kept at `path`: now, when the
 * last slot and any start made elsewhere are a spacing past, and
 * otherwise a spacing after the later of them. The read and the write
 * are one step under a lock, so claims made at once are given slots a
 * spacing apart, in the order they took the lock.
 */
export async function claimCouncilStart(
	path: string,
	claim: StartClaim,
): Promise<StartSlot> {
	return (await takeSlot(path, claim)).slot;
}

/** A slot taken, with what it kept and the last it replaced. */
interface Taken {
	readonly slot: StartSlot;
	readonly kept: KeptSlot;
	readonly replaced: KeptSlot | undefined;
}

async function takeSlot(path: string, claim: StartClaim): Promise<Taken> {
	await mkdir(dirname(path), { recursive: true });
	return withFileLock(path, async () => {
		const spacing = claim.spacingMs ?? COUNCIL_START_SPACING_MS;
		const now = claim.now.getTime();
		const last = await lastSlot(path);
		const lastAt = last === undefined ? undefined : Date.parse(last.startAt);
		const before = [lastAt, claim.startedElsewhereAt?.getTime()].filter(
			(at): at is number =>
				at !== undefined && at - now <= FURTHEST_SLOT_AHEAD_MS,
		);
		const startAt = Math.max(now, ...before.map((at) => at + spacing));
		const kept: KeptSlot = {
			startAt: new Date(startAt).toISOString(),
			by: claim.by,
			change: claim.change,
		};
		await keep(path, kept);
		const ahead = Math.max(0, Math.ceil((startAt - now) / spacing) - 1);
		// Named only when the kept slot is what set the wait, not a start
		// read from the transcripts. A round that took the kept slot stamps
		// its own folder a moment after it, so a start read that soon after
		// the slot is that same round.
		const behindLast =
			startAt > now &&
			last !== undefined &&
			lastAt !== undefined &&
			before.includes(lastAt) &&
			startAt - (lastAt + spacing) <= SAME_ROUND_WITHIN_MS;
		return {
			slot: {
				startAt: new Date(startAt),
				ahead,
				...(behindLast ? { behind: { by: last.by, change: last.change } } : {}),
			},
			kept,
			replaced: last,
		};
	});
}

async function keep(path: string, slot: KeptSlot): Promise<void> {
	const next = `${path}.${process.pid}.tmp`;
	await writeFile(next, `${JSON.stringify(slot)}\n`);
	await rename(next, path);
}

/**
 * Gives `taken` back when it is still the last slot kept, putting back
 * the one it replaced, so a round given up doesn't hold the next behind
 * it. Behind a later claim it stays, as a gap.
 */
async function giveBack(path: string, taken: Taken): Promise<void> {
	await withFileLock(path, async () => {
		const last = await lastSlot(path);
		const ours =
			last !== undefined &&
			last.startAt === taken.kept.startAt &&
			last.by === taken.kept.by &&
			last.change === taken.kept.change;
		if (!ours) return;
		if (taken.replaced === undefined) await rm(path, { force: true });
		else await keep(path, taken.replaced);
	});
}

/** What a wait for a start answers. */
export interface CouncilStart {
	/** What the round's answer should say about its wait, when it waited. */
	readonly waited?: string;
	/** Why it starts nothing, when it was stopped before or while it waited. */
	readonly cancelled?: string;
	/**
	 * Gives the slot back, for a round refused once its wait is over, so
	 * the next round waits behind none that never started (`giveBack`).
	 */
	readonly release?: () => Promise<void>;
}

/**
 * Takes the next slot and waits for it, answering what the round's
 * answer should say about the wait, or nothing when it started at
 * once. Stopped by `signal`, before or while it waits, it says so in
 * `cancelled` and gives its slot back (`giveBack`).
 */
export async function awaitCouncilStart(
	path: string,
	claim: StartClaim,
	signal?: AbortSignal,
): Promise<CouncilStart> {
	if (signal?.aborted === true) {
		return { cancelled: "It was stopped before it took a start." };
	}
	const taken = await takeSlot(path, claim);
	const { slot } = taken;
	const release = () => giveBack(path, taken);
	const waitMs = slot.startAt.getTime() - Date.now();
	if (waitMs <= 0) return { release };
	const spacing = claim.spacingMs ?? COUNCIL_START_SPACING_MS;
	try {
		await sleep(waitMs, undefined, signal === undefined ? {} : { signal });
	} catch {
		// Only an abort rejects the timer: the round was given up while it
		// waited, which the answer says rather than starting it.
		await giveBack(path, taken);
		return { cancelled: stoppedSaid(slot, spacing) };
	}
	return { waited: waitSaid(slot, spacing), release };
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

/** The last slot kept at `path`, or nothing when none is or it can't be read. */
async function lastSlot(path: string): Promise<KeptSlot | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		// None kept yet, or unreadable: no start to wait behind.
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return isKeptSlot(parsed) ? parsed : undefined;
	} catch {
		// Cut short or overwritten by hand: no start to wait behind.
		return undefined;
	}
}

function isKeptSlot(value: unknown): value is KeptSlot {
	return (
		typeof value === "object" &&
		value !== null &&
		"startAt" in value &&
		typeof value.startAt === "string" &&
		Number.isFinite(Date.parse(value.startAt)) &&
		"by" in value &&
		typeof value.by === "string" &&
		"change" in value &&
		typeof value.change === "string"
	);
}

function waitSaid(slot: StartSlot, spacing: number): string {
	return `It waited for its start at ${placeSaid(slot)}, since one roster round starts on this machine each ${spacing / 60_000} minutes.`;
}

function stoppedSaid(slot: StartSlot, spacing: number): string {
	return `It was stopped while it waited for its start at ${placeSaid(slot)}, so nothing was started. One roster round starts on this machine each ${spacing / 60_000} minutes.`;
}

function placeSaid(slot: StartSlot): string {
	const at = slot.startAt.toISOString().slice(11, 19);
	const behind =
		slot.behind === undefined
			? ""
			: `, behind ${slot.behind.change} (asked by ${slot.behind.by})`;
	const place =
		slot.ahead === 0
			? "next in line"
			: `${slot.ahead} ${slot.ahead === 1 ? "round" : "rounds"} ahead`;
	return `${at} UTC, ${place}${behind}`;
}
