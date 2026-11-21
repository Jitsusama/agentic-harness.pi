/**
 * What restore offers: the sessions lost and worth offering back, the
 * launcher's restore file written from the records, and the sessions
 * other machines carried or hosts let go that belong in it.
 *
 * Nothing here opens a window; reopening what this finds is
 * `reopen.ts`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { machineBooted } from "../../../lib/internal/machine/booted.ts";
import { thisMachine } from "../../../lib/internal/machine/machine.ts";
import { sessionsDir, stateDir } from "../../../lib/internal/paths.ts";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/documents/frontmatter.ts";
import { extractTitle } from "../../../lib/internal/quest/documents/quest-doc.ts";
import { windowWorkspaceOf } from "../../../lib/internal/quest/fields/orchestration.ts";
import { takeUpCarried } from "../../../lib/internal/quest/reopening/carried.ts";
import {
	bootEndedBefore,
	type RestoreEntry,
	releasedEntry,
	restoreFileOf,
	restoreFilePath,
	writeRestoreFile,
} from "../../../lib/internal/quest/reopening/restore-file.ts";
import {
	readWindowsNote,
	windowsNotePath,
	windowsToReopen,
} from "../../../lib/internal/quest/reopening/windows-elsewhere.ts";
import { currentBootToken } from "../../../lib/internal/quest/sessions/process-liveness.ts";
import { indexSessionFiles } from "../../../lib/internal/quest/sessions/session-liveness.ts";
import {
	carriedOnElsewhere,
	hostKeeps,
	type LastBootSessions,
	lastBootSessions,
	recentlyClosed,
	restorable,
	type SessionRecord,
	startedAgain,
	wasLost,
} from "../../../lib/internal/quest/sessions/session-registry.ts";
import { isLiveStatus } from "../../../lib/internal/quest/status.ts";
import { questWorkspacesRoot } from "../../../lib/internal/quest/workspace/workspace-root.ts";
import { rosterHolds } from "../../../lib/internal/session/host-holds.ts";
import { sessionLogHeader } from "../../../lib/internal/session/log-header.ts";
import {
	moveFolder,
	readMoveNote,
	readMoveNotes,
	removeMoveNote,
} from "../../../lib/internal/session/move.ts";
import { questAddress } from "../../../lib/mesh/address.ts";
import type { QuestFrontMatter } from "../../../lib/quest/types.ts";
import { forgetRecord, loadRecords, observeRecords } from "./records.ts";

/**
 * The sessions worth offering back, newest loss first.
 *
 * Probes first, so a session lost to a crash is recognised as lost
 * before the question is asked: the record it left behind still
 * claims to be open, and only a probe can settle that.
 */
export function restorableSessions(
	saved: (sessionId: string) => boolean = savedSessions(),
): SessionRecord[] {
	const stored = loadRecords();
	observeRecords(stored);
	// Re-read rather than patching the list in place: observing writes
	// the repairs to disk, and the reload is what makes the answer the
	// same one a second reader would get.
	const records = loadRecords().map((entry) => entry.record);
	const kept = keptByHost();
	// A session pi never saved is brought back by starting one in its
	// place, by restore or by hand from its recipe line; once that has
	// happened there is nothing left to offer, and its record goes.
	return restorable(records).filter((record) => {
		// Its host brings it back; a terminal too would be a second writer.
		if (kept(record)) return false;
		if (saved(record.sessionId) || !startedAgain(record, records)) return true;
		forgetRecord(record.sessionId);
		return false;
	});
}

/**
 * What restore offers after a boot: the lost sessions that were running
 * when the last boot ended, and the rest of the lost, only to be named
 * (see `lastBootSessions`).
 */
export function lastBootRestorable(
	saved: (sessionId: string) => boolean = savedSessions(),
	thisBoot: string | undefined = currentBootToken(),
	parentOf: (sessionId: string) => string | undefined = logParents(),
): LastBootSessions {
	const lost = new Set(
		restorableSessions(saved).map((record) => record.sessionId),
	);
	const records = loadRecords().map((entry) => entry.record);
	const hostHas = keptByHost();
	const found = lastBootSessions(records, thisBoot, endedBoot(thisBoot));
	const kept = (list: SessionRecord[]) =>
		list.filter((record) => lost.has(record.sessionId));
	const offered = kept(found.offered);
	const parked = found.parked.filter((record) => !hostHas(record));
	const carried = carriedOnElsewhere(
		[...offered, ...parked],
		records.filter((record) => !record.closedAt),
		parentOf,
	);
	const uncarried = (list: SessionRecord[]) =>
		list.filter((record) => !carried.has(record.sessionId));
	return {
		...found,
		offered: uncarried(offered),
		older: kept(found.older),
		parked: uncarried(parked),
	};
}

/**
 * Each saved session's parent, as its log's header names it: the session
 * a rollover or a fork carried on from. Logs are found once, when this
 * is made, and each header read when asked.
 */
function logParents(
	logs: ReadonlyMap<string, string> = indexSessionFiles(sessionsDir()),
): (sessionId: string) => string | undefined {
	return (sessionId) => {
		const log = logs.get(sessionId);
		const parentLog = log ? sessionLogHeader(log)?.parentSession : undefined;
		return parentLog ? sessionLogHeader(parentLog)?.id : undefined;
	};
}

/**
 * Whether a host has a session, by what its record says or by a host's
 * roster keeping it: a record can still name the plain pi the session
 * moved from, or a host that crashed and takes it up again as it
 * starts. Rosters are read once, when this is made.
 */
export function keptByHost(
	holds: ReadonlyMap<string, string> = rosterHolds(),
): (record: SessionRecord) => boolean {
	return (record) => hostKeeps(record) || holds.has(record.sessionId);
}

/**
 * Rewrite the launcher's restore file from the records as they stand,
 * probing nothing (see lib/internal/quest/reopening/restore-file.ts). A session
 * starting calls it, so one reopened drops out of the launcher's list
 * within moments. Best-effort: a file that can't be written leaves the
 * last one in place, which only lists a session already back.
 */
export function refreshRestoreFile(
	questsRoot: string,
	stateHome: string = defaultStateHome(),
): void {
	try {
		const thisBoot = currentBootToken();
		const logs = indexSessionFiles(sessionsDir());
		const note = readWindowsNote(windowsNotePath(stateDir("quest-workflow")));
		const file = restoreFileOf(
			loadRecords(),
			thisBoot,
			(questId) => questTitle(questsRoot, questId),
			savedSessions(),
			(lastBoot) => windowsToReopen(note, thisBoot, lastBoot),
			carriedHome(questsRoot),
			endedBoot(thisBoot, stateHome),
			(questId) => questLive(questsRoot, questId),
			releasedHome(questsRoot),
			{
				workspaceOf: workspaceReader(questsRoot),
				parentOf: logParents(logs),
				logOf: (sessionId) => logs.get(sessionId),
			},
		);
		writeRestoreFile(restoreFilePath(stateHome), file);
	} catch {
		// The launcher keeps the file it has; the next start writes again.
	}
}

/**
 * The state folder the restore file sits under. An empty XDG_STATE_HOME
 * means the default, as the spec says; read as a path it would write
 * into whatever folder the process stands in.
 */
function defaultStateHome(): string {
	return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}

/**
 * The boot this boot already named as the last in the restore file, so
 * every later reading keeps it (see `bootEndedBefore`).
 */
function endedBoot(
	thisBoot: string | undefined,
	stateHome: string = defaultStateHome(),
): string | undefined {
	return bootEndedBefore(restoreFilePath(stateHome), thisBoot, machineBooted());
}

/**
 * The sessions other machines carried here, each placed in pi's store
 * for the folder it reopens in, less any a pi has run here since
 * (lib/internal/quest/reopening/carried.ts).
 */
export function carriedHome(questsRoot: string): RestoreEntry[] {
	const ranHere = new Set(loadRecords().map(({ record }) => record.sessionId));
	return takeUpCarried({
		workspaces: questWorkspacesRoot(),
		here: thisMachine(),
		sessions: sessionsDir(),
		known: indexSessionFiles(sessionsDir()),
		quests: questsRoot,
		titleOf: (questId) => questTitle(questsRoot, questId),
	}).filter((entry) => !ranHere.has(entry.id));
}

/**
 * Take away the note a move left for a session now taken up where it
 * runs: in plain pi, since no host is to adopt it; in a host, a
 * release's note, which would have the launcher open it again beside
 * the host. A note for a host stays, for the cutover to take once it
 * sees the session held there.
 *
 * A reload settles nothing: it is the same process going on, already
 * settled at its own start, and any note there now is its own move's,
 * left as it ends. Taken away, nothing offers that session back: on 15
 * November a move left XUBK2E's note as its run ended, the reload onto
 * a moved install started in the same moment, and the release lost it.
 */
export function settleMoveNote(
	sessionId: string,
	start: { readonly hosted: boolean; readonly reason: StartReason },
	folder: string = moveFolder(),
): void {
	if (start.reason === "reload") return;
	if (!start.hosted || readMoveNote(sessionId, folder)?.to === "pi")
		removeMoveNote(sessionId, folder);
}

/** Why a session started, as pi's `session_start` says. */
type StartReason = "startup" | "reload" | "new" | "resume" | "fork";

/**
 * The sessions their hosts let go to plain pi, from the notes their
 * conversations left as they closed (lib/internal/session/move.ts).
 * One a host keeps again is left out, since opening it here would give
 * its log a second writer.
 */
export function releasedHome(
	questsRoot: string,
	folder: string = moveFolder(),
	kept: () => ReadonlyMap<string, string> = rosterHolds,
): RestoreEntry[] {
	const notes = readMoveNotes(folder).filter((note) => note.to === "pi");
	const holds = notes.length > 0 ? kept() : new Map<string, string>();
	return notes
		.filter((note) => !holds.has(note.session))
		.map((note) => releasedEntry(note, (id) => questTitle(questsRoot, id)));
}

/** A quest's title from its README, or nothing when it can't be read. */
function questTitle(questsRoot: string, questId: string): string | undefined {
	try {
		return extractTitle(
			readFileSync(join(questsRoot, questId, "README.md"), "utf8"),
		);
	} catch {
		// A quest folder gone or unreadable: the entry falls back to its folder.
		return undefined;
	}
}

/**
 * The workspace, by name, a quest's sessions open their windows on
 * (windowWorkspaceOf), each README read once however many sessions and
 * orchestrations name it.
 */
function workspaceReader(
	questsRoot: string,
): (questId: string) => string | undefined {
	const read = new Map<string, QuestFrontMatter | undefined>();
	const frontMatter = (questId: string) => {
		if (!read.has(questId))
			read.set(questId, questFrontMatter(questsRoot, questId));
		return read.get(questId);
	};
	return (questId) => {
		const workspace = windowWorkspaceOf(questId, frontMatter);
		return workspace ? questAddress(workspace) : undefined;
	};
}

/** A quest's front matter from its README, or nothing when unreadable. */
function questFrontMatter(
	questsRoot: string,
	questId: string,
): QuestFrontMatter | undefined {
	try {
		return parseQuestFrontMatter(
			readFileSync(join(questsRoot, questId, "README.md"), "utf8"),
		)?.frontMatter;
	} catch {
		// A quest folder gone or unreadable: its sessions get no workspace.
		return undefined;
	}
}

/**
 * Whether a quest is still live, by its README's status: one concluded
 * or retired is not. A quest that can't be read counts as live, since
 * nothing says its work is done.
 */
function questLive(questsRoot: string, questId: string): boolean {
	let readme: string;
	try {
		readme = readFileSync(join(questsRoot, questId, "README.md"), "utf8");
	} catch {
		// A quest folder gone or unreadable says nothing of its status.
		return true;
	}
	return isLiveStatus(parseQuestFrontMatter(readme)?.frontMatter.status);
}

/**
 * Which sessions pi has saved, and so can resume, read from its session
 * store once.
 *
 * A store that holds no session at all, or cannot be read, says nothing
 * about any of them: a pi keeping its sessions elsewhere would look
 * like one that saved none, and starting a saved session afresh would
 * lose it. Then every session counts as saved, as it did before.
 */
export function savedSessions(): (sessionId: string) => boolean {
	const index = indexSessionFiles(sessionsDir());
	if (index.size === 0) return () => true;
	return (sessionId) => index.has(sessionId);
}

/**
 * How far back restore looks for sessions closed on purpose. A day
 * covers the evening's tabs the next morning, which is the recovery
 * this exists for, without dredging up last week.
 */
const RECENTLY_CLOSED_HOURS = 24;

/**
 * The sessions closed on purpose within the last day, most recent
 * first. Reads without probing, so ask after `restorableSessions`,
 * which has already settled what the open records really are.
 */
export function recentlyClosedSessions(now = new Date()): SessionRecord[] {
	const kept = keptByHost();
	return recentlyClosed(
		loadRecords()
			.map((entry) => entry.record)
			.filter((record) => !kept(record)),
		{ now, withinHours: RECENTLY_CLOSED_HOURS },
	);
}

/**
 * How many sessions are recorded as lost, without probing anything.
 *
 * For the start-up hint, which must stay cheap: the hard rule is that
 * starting a session never shells out to inspect history. A record
 * already closed says what it is without asking the operating system,
 * so a crash nobody has noticed yet is not counted here. It becomes
 * visible the first time something reads the registry properly, which
 * is what `quest reopen-sessions` does.
 */
export function lostSessionCount(): number {
	const kept = keptByHost();
	return loadRecords().filter(({ record }) => wasLost(record) && !kept(record))
		.length;
}
