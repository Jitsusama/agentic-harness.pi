/**
 * The file the launcher reads to offer back what a boot's end took
 * away: `restore.json` in pi's state folder, written whole by rename and
 * never deleted, so a watcher always finds one complete answer.
 *
 * Its shape is the launcher's contract (Y2YBTS, 29 October): the boot
 * the sessions ran in, and one entry per session, which the launcher
 * reopens through its own resume, in a window of its own under a login
 * shell. The launcher compares `boot` with this boot's id, and while
 * they match, or `sessions` is empty, it has nothing to offer, but for
 * an entry marked `carried` (Y2YBTS, 30 October): a session another
 * machine carried home before it went away, offered whatever the boot
 * until it runs here (carried.ts). An entry marked `fresh` is a session
 * pi never saved, which the launcher starts afresh under its id. One
 * marked `parked` was asleep when the boot ended, parked while idle,
 * and reopens as any other: idle by its log, it parks again within its
 * first minute, so it comes back as it was.
 * A parked session of a quest since concluded or retired isn't offered,
 * since its work is done and it parked for having nothing left to do.
 * One marked `hosted` ran in a shared pi host, which brings the
 * conversation back itself, so the launcher's Reopen Them All opens only
 * its viewer where it was, never a pi that would start it twice (N4S6OF
 * and Y2YBTS, 9 November; core.nix #3316, 11 November). One marked
 * `released` was let go by its host to
 * be opened in plain pi from the same file, and is offered whatever the
 * boot until a plain pi starts it (KP0L6A, 10 November).
 * A released session has always run here, so it is offered while its
 * move note stands (lib/internal/session/move.ts) rather than by the
 * records, and stands in for any other entry for that session.
 * A session whose conversation another one carries on, coming back or
 * running, isn't offered, so a reopen never opens two on one
 * conversation (carriedOnElsewhere). Each entry on a quest names the
 * workspace its window opens on, by name (KP0L6A, 13 November).
 *
 * Worked out without probing any process, since it is written as each
 * pi starts, and starting a session never shells out: a record from
 * another boot is dead by its boot token alone, and one a power-off
 * left open ended at its last heartbeat, as a probe would decide.
 */

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { questAddress, sessionAddress } from "../../mesh/address.ts";
import { realmSegments, type SessionRealm, sessionRealm } from "../realm.ts";
import type { CarriedEnvironment } from "../session/carried-environment.ts";
import type { MoveNote } from "../session/move.ts";
import type { CarriedHome } from "./carried.ts";
import { atomicWriteFile } from "./io.ts";
import {
	carriedOnElsewhere,
	closeRecord,
	lastBootSessions,
	type SessionRecord,
} from "./session-registry.ts";
import type { BootWindows } from "./windows-elsewhere.ts";

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
	/**
	 * For a session another machine holds, which kept running through
	 * this machine's power-off: that machine, and the words that join it,
	 * run in place of `pi --session` (windows-elsewhere.ts). `cwd` is then
	 * the window's folder here.
	 */
	readonly machine?: string;
	readonly attach?: readonly string[];
	/**
	 * For a session another machine carried here as it went away: that
	 * machine, and when. It reopens like any session here, in `cwd`.
	 */
	readonly carried?: { readonly from: string; readonly at: string };
	/**
	 * For a session pi never saved, as one that never answered: there is
	 * no file for `pi --session` to resume, so the launcher starts it
	 * afresh under its id with `pi --session-id`, its quest autoloaded
	 * (Y2YBTS, 1 November).
	 */
	readonly fresh?: true;
	/**
	 * For a session parked while idle when the boot ended: asleep rather
	 * than lost, and `lostAt` is when it parked.
	 */
	readonly parked?: true;
	/**
	 * For a session that ran in a shared pi host rather than a pi of its
	 * own: the host keeps it, so no window reopens it.
	 */
	readonly hosted?: true;
	/**
	 * For a session its host let go to plain pi: that host's key, such as
	 * `work-attended`, and when. It reopens like any session here, in
	 * `cwd`.
	 */
	readonly released?: { readonly from: string; readonly at: string };
	/**
	 * The variables a session ran here with that say how its commands
	 * run, in the agent fence and through the spawner, each a plain word:
	 * the launcher starts it again behind `env` with them, so one fenced
	 * before the boot is fenced after it.
	 */
	readonly env?: CarriedEnvironment;
	/**
	 * The niri workspace its window opens on, by name: the address of the
	 * topmost orchestrator over its quest, else its quest's own
	 * (windowWorkspaceOf in orchestration.ts), so a reopen after a boot
	 * never puts it where the person is (KP0L6A, 13 November). Absent
	 * with no quest.
	 */
	readonly workspace?: string;
}

/** How a restore file's sessions are placed and which are left out. */
export interface RestorePlacing {
	/** The workspace a quest's sessions open on, as an address. */
	readonly workspaceOf?: (questId: string) => string | undefined;
	/** The session a session's log carried on from, for `carriedOnElsewhere`. */
	readonly parentOf?: (sessionId: string) => string | undefined;
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

/**
 * Where the file lives, under the state home: pi's own folder for the
 * machine's home realm, as the launcher has always read it, and the
 * harness's folder for that realm for any other (see realm.ts).
 */
export function restoreFilePath(
	stateHome: string,
	realm: SessionRealm = sessionRealm(),
): string {
	const own = realmSegments(realm);
	return own.length === 0
		? join(stateHome, "pi", "restore.json")
		: join(stateHome, "pi", "agentic-harness.pi", ...own, "restore.json");
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
	/** What the windows note says was left, read by `windowsToReopen`. */
	elsewhere: (lastBoot: string | undefined) => BootWindows | undefined = () =>
		undefined,
	/** Sessions carried here, read by `carriedEntry`. */
	carried: readonly RestoreEntry[] = [],
	/** The boot this boot already named as the last, by `bootEndedBefore`. */
	ended?: string,
	/** Whether a quest is still live, so a session parked on it returns. */
	live: (questId: string) => boolean = () => true,
	/** Sessions their hosts let go, read by `releasedEntry`. */
	released: readonly RestoreEntry[] = [],
	placing: RestorePlacing = {},
): RestoreFile {
	const letGo = new Set(released.map((entry) => entry.id));
	const unreleased = (entry: RestoreEntry) => !letGo.has(entry.id);
	// A record exists only once a pi has run the session on this machine.
	const ranHere = new Set(stored.map(({ record }) => record.sessionId));
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
	const found = lastBootSessions(records, thisBoot, ended);
	const parked = found.parked.filter(
		(record) => record.quest === undefined || live(record.quest),
	);
	const carriedOn = placing.parentOf
		? carriedOnElsewhere(
				[...found.offered, ...parked],
				records.filter((record) => record.closedAt === undefined),
				placing.parentOf,
			)
		: new Set<string>();
	const uncarried = (record: SessionRecord) => !carriedOn.has(record.sessionId);
	const joins = elsewhere(found.boot);
	const boot = found.boot ?? joins?.boot;
	const placed = (entry: RestoreEntry): RestoreEntry => {
		const workspace =
			entry.workspace ??
			(entry.quest ? placing.workspaceOf?.(entry.quest) : undefined);
		return workspace ? { ...entry, workspace } : entry;
	};
	return {
		v: RESTORE_FILE_VERSION,
		...(boot !== undefined ? { boot } : {}),
		sessions: [
			...[
				...found.offered
					.filter(uncarried)
					.map((record) =>
						saved(record.sessionId)
							? entryOf(record, titleOf)
							: { ...entryOf(record, titleOf), fresh: true as const },
					),
				...parked.filter(uncarried).map((record) => ({
					...entryOf(record, titleOf),
					parked: true as const,
				})),
				...(joins?.windows ?? []).map(
					(window): RestoreEntry => ({
						id: window.id,
						address: window.address,
						title: window.title,
						...(window.quest ? { quest: window.quest } : {}),
						cwd: window.cwd,
						// Still running there: lost here only with the boot.
						lostAt: "",
						machine: window.machine,
						attach: window.attach,
					}),
				),
				...carried.filter((entry) => !ranHere.has(entry.id)),
			].filter(unreleased),
			...released,
		].map(placed),
	};
}

/**
 * The entry for a session its host let go to plain pi, from the note its
 * conversation left as it closed: its title as it left, else its
 * quest's, else the folder's name.
 */
export function releasedEntry(
	note: MoveNote,
	titleOf: (questId: string) => string | undefined = () => undefined,
): RestoreEntry {
	const folder = note.cwd.split("/").filter(Boolean).pop() ?? note.cwd;
	return {
		id: note.session,
		address: note.quest
			? questAddress(note.quest)
			: sessionAddress(note.session),
		title:
			note.title ?? (note.quest ? titleOf(note.quest) : undefined) ?? folder,
		...(note.quest ? { quest: note.quest } : {}),
		cwd: note.cwd,
		lostAt: note.at,
		released: { from: note.from ?? "", at: note.at },
	};
}

/**
 * The entry for a session carried here, to reopen in `cwd`: its window's
 * title as it left, else its quest's, else the folder's name.
 */
export function carriedEntry(
	carried: CarriedHome,
	cwd: string,
	titleOf: (questId: string) => string | undefined = () => undefined,
): RestoreEntry {
	const folder = cwd.split("/").filter(Boolean).pop() ?? cwd;
	return {
		id: carried.id,
		address: carried.quest
			? questAddress(carried.quest)
			: sessionAddress(carried.id),
		title:
			carried.title ??
			(carried.quest ? titleOf(carried.quest) : undefined) ??
			folder,
		...(carried.quest ? { quest: carried.quest } : {}),
		cwd,
		lostAt: carried.at,
		carried: { from: carried.from, at: carried.at },
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
		...(record.process?.hosted ? { hosted: true as const } : {}),
		...(record.env ? { env: record.env } : {}),
	};
}

/**
 * The boot the file at `path` names as the last, when it was written
 * since this boot began (`bootedAt`, in milliseconds) and names another:
 * the boot this boot already worked out, kept so a session run again
 * can't move it to an older one. Undefined when the file is older than
 * this boot, names this one, is unreadable, or the machine can't say
 * when it booted; the records decide then.
 */
export function bootEndedBefore(
	path: string,
	thisBoot: string | undefined,
	bootedAt: number | undefined,
): string | undefined {
	if (bootedAt === undefined || thisBoot === undefined) return undefined;
	try {
		if (statSync(path).mtimeMs < bootedAt) return undefined;
		const boot: unknown = JSON.parse(readFileSync(path, "utf8"))?.boot;
		return typeof boot === "string" && boot !== "" && boot !== thisBoot
			? boot
			: undefined;
	} catch {
		// No file, or not one this shape: the records decide.
		return undefined;
	}
}

/**
 * Write the file whole, by rename, so a reader never sees half of it,
 * and only when it says something new: a timer rewrites it each minute,
 * and the launcher wakes for every change to it.
 */
export function writeRestoreFile(path: string, file: RestoreFile): void {
	const text = `${JSON.stringify(file, null, 2)}\n`;
	try {
		if (readFileSync(path, "utf8") === text) return;
	} catch {
		// No file yet: this is the first.
	}
	mkdirSync(dirname(path), { recursive: true });
	atomicWriteFile(path, text);
}
