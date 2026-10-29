/**
 * The file the launcher reads to offer back what a boot's end took
 * away: `restore.json` in pi's state folder, written whole by rename and
 * never deleted, so a watcher always finds one complete answer.
 *
 * Its shape is the launcher's contract (Y2YBTS, 29 October): the boot
 * the sessions ran in, and one entry per session, which the launcher
 * reopens through its own resume, in a window of its own under a login
 * shell. The launcher compares `boot` with this boot's id, and while
 * they match, or `sessions` is empty, it has nothing to offer.
 *
 * Worked out without probing any process, since it is written as each
 * pi starts, and starting a session never shells out: a record from
 * another boot is dead by its boot token alone, and one a power-off
 * left open ended at its last heartbeat, as a probe would decide.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { questAddress, sessionAddress } from "../../mesh/address.ts";
import { atomicWriteFile } from "./io.ts";
import {
	closeRecord,
	lastBootSessions,
	type SessionRecord,
} from "./session-registry.ts";

/** The version of the file's shape. */
export const RESTORE_FILE_VERSION = 1;

/** One session to offer back. */
export interface RestoreEntry {
	readonly id: string;
	/** The address it answered to on the mesh: its quest's, or its own. */
	readonly address: string;
	/** Its quest's title, or its folder's name when it had no quest. */
	readonly title: string;
	readonly quest?: string;
	readonly cwd: string;
	/** When it was last seen running. */
	readonly lostAt: string;
}

/** The whole file. */
export interface RestoreFile {
	readonly v: typeof RESTORE_FILE_VERSION;
	/** The boot the sessions ran in, absent when none can be named. */
	readonly boot?: string;
	readonly sessions: readonly RestoreEntry[];
}

/** A stored record, with the last moment anything saw it alive. */
export interface SeenRecord {
	readonly record: SessionRecord;
	readonly heartbeatAt: string;
}

/** Where the file lives, under the state home. */
export function restoreFilePath(stateHome: string): string {
	return join(stateHome, "pi", "restore.json");
}

/**
 * What the file says for these records, seen from `thisBoot`. A record
 * another boot left open is read as having ended at its heartbeat.
 */
export function restoreFileOf(
	stored: readonly SeenRecord[],
	thisBoot: string | undefined,
	titleOf: (questId: string) => string | undefined = () => undefined,
	saved: (sessionId: string) => boolean = () => true,
): RestoreFile {
	const records = stored.map(({ record, heartbeatAt }) => {
		const boot = record.process?.bootToken;
		const leftOpen =
			record.closedAt === undefined &&
			boot !== undefined &&
			thisBoot !== undefined &&
			boot !== thisBoot;
		return leftOpen
			? closeRecord(record, "died", new Date(heartbeatAt))
			: record;
	});
	const found = lastBootSessions(records, thisBoot);
	return {
		v: RESTORE_FILE_VERSION,
		...(found.boot !== undefined ? { boot: found.boot } : {}),
		sessions: found.offered
			.filter((record) => saved(record.sessionId))
			.map((record) => entryOf(record, titleOf)),
	};
}

function entryOf(
	record: SessionRecord,
	titleOf: (questId: string) => string | undefined,
): RestoreEntry {
	const folder = record.cwd.split("/").filter(Boolean).pop() ?? record.cwd;
	return {
		id: record.sessionId,
		address: record.quest
			? questAddress(record.quest)
			: sessionAddress(record.sessionId),
		title: (record.quest ? titleOf(record.quest) : undefined) ?? folder,
		...(record.quest ? { quest: record.quest } : {}),
		cwd: record.cwd,
		lostAt: record.closedAt ?? "",
	};
}

/** Write the file whole, by rename, so a reader never sees half of it. */
export function writeRestoreFile(path: string, file: RestoreFile): void {
	mkdirSync(dirname(path), { recursive: true });
	atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`);
}
