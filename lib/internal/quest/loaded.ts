/**
 * Which quest a session has loaded, read from the session registry.
 *
 * In the library rather than the quest workflow, because other
 * extensions want the answer and extensions do not import one another:
 * a review round picks its roster by the quest it is working on. The
 * registry is the quest workflow's own record of each session, written
 * whenever a quest is loaded or put down, so reading it is asking the
 * workflow without reaching into it.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../paths.ts";
import {
	parseSessionRecord,
	type SessionRecord,
	wasLost,
} from "./session-registry.ts";

/** Where the quest workflow keeps one record per session. */
export function sessionRegistryDir(): string {
	return join(stateDir("quest-workflow"), "sessions");
}

/**
 * Session ids are uuids, so anything else is either corruption or an
 * attempt to escape the directory, and is never read.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/**
 * The sessions nobody closed: those whose record is still open, and
 * those a crash or a signal took away, such as every session when the
 * machine shuts down. Restore offers the lost ones back, so what they
 * hold is still theirs. Only a quit or a swap is someone's choice.
 *
 * Given `lostSince`, a session lost before it no longer counts: one
 * nobody brought back in that long is one nobody is waiting on, and
 * on 11 November 197 such sessions, lost over eight days, held 405
 * trees between them.
 */
export async function sessionsNobodyClosed(
	dir: string = sessionRegistryDir(),
	lostSince?: number,
): Promise<ReadonlySet<string>> {
	const records = await everyRecord(dir);
	return new Set(
		records
			.filter((record) => nobodyClosed(record, lostSince))
			.map((record) => record.sessionId),
	);
}

/**
 * The working folders of every session that may work in one again:
 * those {@link sessionsNobodyClosed} names, and those parked, which a
 * wake takes up in the folder they left. A hosted conversation's folder
 * is no process's working folder, so this is the only sign of it.
 */
export async function foldersOfSessionsNobodyClosed(
	dir: string = sessionRegistryDir(),
	lostSince?: number,
): Promise<string[]> {
	const records = await everyRecord(dir);
	return records
		.filter(
			(record) =>
				nobodyClosed(record, lostSince) || record.endReason === "parked",
		)
		.map((record) => record.cwd);
}

function nobodyClosed(record: SessionRecord, lostSince?: number): boolean {
	if (!record.closedAt) return true;
	if (!wasLost(record)) return false;
	return lostSince === undefined || Date.parse(record.closedAt) >= lostSince;
}

/** Every session record that reads, in no order. */
async function everyRecord(dir: string): Promise<SessionRecord[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		// No registry is a machine where no session has loaded a quest.
		return [];
	}
	const records = await Promise.all(
		names
			.filter((name) => name.endsWith(".json"))
			.map(async (name) => {
				try {
					return parseSessionRecord(
						JSON.parse(await readFile(join(dir, name), "utf8")),
					);
				} catch {
					// Gone since the listing, or half written: a record that will
					// not read names no session anybody could trust.
					return undefined;
				}
			}),
	);
	return records.filter(
		(record): record is SessionRecord => record !== undefined,
	);
}

/** The quest a session has loaded now, or undefined when it has none. */
export async function questLoadedIn(
	sessionId: string,
	dir: string = sessionRegistryDir(),
): Promise<string | undefined> {
	if (!SAFE_SESSION_ID.test(sessionId)) return undefined;
	let text: string;
	try {
		text = await readFile(join(dir, `${sessionId}.json`), "utf8");
	} catch {
		// No record is a session the quest workflow never saw, which is
		// a session with no quest loaded.
		return undefined;
	}
	try {
		return parseSessionRecord(JSON.parse(text))?.quest;
	} catch {
		// A record that will not parse names no quest anybody could
		// trust, and a roster choice is not worth failing a round over.
		return undefined;
	}
}
