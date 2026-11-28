/**
 * Every start the machine's line gave, one JSON line each, so how long
 * rounds waited can be read back afterwards: the line itself keeps only
 * its last start, and the velocity cell asked on 27 November for each
 * ticket's ask and start, to read a p95 wait from (A210E4CA 1490ad4d).
 *
 * Kept a file a day beside the line, in `history/`, so a day is read
 * with `jq` alone and an old day goes by removing its file; days older
 * than {@link KEEP_DAYS} go when a new day's file is first written.
 *
 * The line reads it back too: how many starts the last hour gave is the
 * pace a round joining it is due at, when that is slower than the
 * line's own spacing (`startsBetween`).
 */

import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** How many days of starts are kept. */
export const KEEP_DAYS = 14;

/** The folder beside the line the history is kept in. */
const HISTORY = "history";

/** How a day's file is named: its UTC date, then `.jsonl`. */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** A milliseconds day. */
const DAY_MS = 24 * 60 * 60_000;

/** One start, as the history keeps it. */
export interface StartRecord {
	/** The ticket that took it. */
	readonly ticket: string;
	/** The session that asked. */
	readonly by: string;
	/** The change it reads, by label. */
	readonly change: string;
	/** What kind of round, when the ask said. */
	readonly kind?: string;
	/** When it was asked, in ISO form. */
	readonly askedAt: string;
	/** When it started, in ISO form. */
	readonly startAt: string;
	/** How long it waited, in milliseconds. */
	readonly waitedMs: number;
	/** What the machine was last short of while it waited, if anything. */
	readonly heldBy?: string;
}

/**
 * Adds `record` to the history kept in `folder`, the line's own folder,
 * under the day it started. One write a line, appended, so rounds
 * starting at once never lose each other's lines.
 */
export async function recordStart(
	folder: string,
	record: StartRecord,
): Promise<void> {
	const at = join(folder, HISTORY);
	await mkdir(at, { recursive: true });
	const day = record.startAt.slice(0, "YYYY-MM-DD".length);
	const file = join(at, `${day}.jsonl`);
	const days = await readdir(at);
	await appendFile(file, `${JSON.stringify(record)}\n`);
	if (!days.includes(`${day}.jsonl`)) {
		await forgetOldDays(at, days, Date.parse(record.startAt));
	}
}

/**
 * How many starts the history kept in `folder` holds from `since` to
 * `until`, both times in milliseconds and both counted. A day with no
 * file gave none, and a line that isn't a start, as one cut short by a
 * full disk, counts for nothing.
 */
export async function startsBetween(
	folder: string,
	since: number,
	until: number,
): Promise<number> {
	let starts = 0;
	for (const day of daysBetween(since, until)) {
		let text: string;
		try {
			text = await readFile(join(folder, HISTORY, `${day}.jsonl`), "utf8");
		} catch {
			// No start was kept that day.
			continue;
		}
		for (const line of text.split("\n")) {
			const at = startOf(line);
			if (at !== undefined && at >= since && at <= until) starts += 1;
		}
	}
	return starts;
}

/** The UTC days from `since` to `until`, each as its file names it. */
function daysBetween(since: number, until: number): string[] {
	const days: string[] = [];
	const first = Date.parse(
		`${new Date(since).toISOString().slice(0, 10)}T00:00:00Z`,
	);
	for (let day = first; day <= until; day += DAY_MS) {
		days.push(new Date(day).toISOString().slice(0, "YYYY-MM-DD".length));
	}
	return days;
}

/** When the start one history line keeps began, or nothing when it keeps none. */
function startOf(line: string): number | undefined {
	if (line.trim() === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(line);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("startAt" in parsed) ||
			typeof parsed.startAt !== "string"
		) {
			return undefined;
		}
		const at = Date.parse(parsed.startAt);
		return Number.isFinite(at) ? at : undefined;
	} catch {
		// Cut short as it was written: no start to count.
		return undefined;
	}
}

/** Removes the days in `days` older than {@link KEEP_DAYS} before `now`. */
async function forgetOldDays(
	at: string,
	days: readonly string[],
	now: number,
): Promise<void> {
	for (const name of days) {
		const day = DAY_FILE.exec(name)?.[1];
		if (day === undefined) continue;
		if (now - Date.parse(`${day}T00:00:00Z`) > KEEP_DAYS * DAY_MS) {
			await rm(join(at, name), { force: true });
		}
	}
}
