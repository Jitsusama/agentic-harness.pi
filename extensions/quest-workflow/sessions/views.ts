/**
 * The sessions the quest tool lists: those at work now, the recent ones
 * to go back to, the cheap hint a session's start names, and those
 * `show` lists on a quest. Read-only projections over the quests'
 * session lists, the session store and the registry's records.
 */

import { statSync } from "node:fs";
import { sessionsDir } from "../../../lib/internal/paths.ts";
import { discoverQuests } from "../../../lib/internal/quest/discovery.ts";
import {
	type SessionSummary,
	summariseSessions,
} from "../../../lib/internal/quest/reopen.ts";
import {
	activityFromIndex,
	deriveLiveness,
	indexSessionFiles,
	type SessionLiveness,
} from "../../../lib/internal/quest/session-liveness.ts";
import {
	lastOpenAt,
	type SessionRecord,
	wasLost,
} from "../../../lib/internal/quest/session-registry.ts";
import type { QuestSession } from "../../../lib/quest/index.ts";
import { buildSessionSnapshot } from "../liveness.ts";
import type { QuestState } from "../state.ts";
import { loadRecords, observeRecords, seedLiveSessions } from "./records.ts";

/**
 * Project a quest's attached sessions for display: derive each
 * session's liveness from its log in the pi session store, then
 * summarise (order newest-first and flag the resume target). Every
 * session is reported, including dead no-log ones; pruning phantoms
 * is the load verb's job, not this view's. Reads the store fresh
 * against the current time.
 */
export async function projectSessions(
	sessions: QuestSession[],
): Promise<SessionSummary[]> {
	const snapshot = await buildSessionSnapshot(sessions);
	return summariseSessions(sessions.map((s) => deriveLiveness(s, snapshot)));
}

/** A quest currently being worked on, with its liveliest session. */
export interface SessionAtWork {
	questId: string;
	title: string | null;
	kind: string;
	status: string;
	priority: string;
	liveness: SessionLiveness;
	sessionId: string;
	cwd?: string;
	lastActivity?: string;
}

/**
 * A session counts as active work when it is live or idle: a pi
 * running against the quest now, or one recently active.
 */
function isActiveWork(liveness: SessionLiveness): boolean {
	return liveness === "live" || liveness === "idle";
}

/** Rank for workspace ordering: live first, then idle, then the rest. */
function livenessRank(liveness: SessionLiveness): number {
	if (liveness === "live") return 0;
	if (liveness === "idle") return 1;
	return 2;
}

/**
 * The sessions at work: one row per non-detached session of every quest
 * that has active work, so two live panes on one quest read as two
 * rows and a crashed pane shows beside its live sibling rather than
 * being collapsed away. A quest with no live or idle session is left
 * out entirely. Rows are ordered live first, then by recency. Given
 * `only`, a quest's id, just that quest's sessions are read.
 */
export async function sessionsAtWork(
	state: QuestState,
	only?: string,
): Promise<SessionAtWork[]> {
	const { index } = discoverQuests(state.questsRoot);
	const quests = [...index.quests.values()].filter(
		(entry) => only === undefined || entry.doc.frontMatter.id === only,
	);
	// One snapshot across every quest's sessions: derivation is keyed
	// by session id, so a single store walk and probe pass serves all
	// quests rather than re-indexing per quest.
	const allSessions = quests.flatMap((entry) => entry.doc.frontMatter.sessions);
	const snapshot = await buildSessionSnapshot(allSessions);
	const entries: SessionAtWork[] = [];
	for (const entry of quests) {
		const fm = entry.doc.frontMatter;
		const views = fm.sessions
			.map((s) => deriveLiveness(s, snapshot))
			.filter((v) => v.liveness !== "detached")
			.sort((a, b) =>
				byRow(a.liveness, a.lastActivity, b.liveness, b.lastActivity),
			);
		// A quest earns a place in the workspace only when it has a live
		// or idle session; its crashed and unknown siblings then ride
		// along so a crash shows next to the work it died beside.
		if (!views.some((v) => isActiveWork(v.liveness))) continue;
		for (const view of views) {
			entries.push({
				questId: fm.id,
				title: entry.doc.title ?? null,
				kind: fm.kind,
				status: fm.status,
				priority: fm.priority,
				liveness: view.liveness,
				sessionId: view.id,
				...(view.cwd ? { cwd: view.cwd } : {}),
				...(view.lastActivity ? { lastActivity: view.lastActivity } : {}),
			});
		}
	}
	return entries.sort((a, b) =>
		byRow(a.liveness, a.lastActivity, b.liveness, b.lastActivity),
	);
}

/**
 * One row per prior pi session, drawn from every quest's session
 * index and resolved to a quest, cwd, activity age and read-time
 * liveness over a single snapshot. Unlike the workspace, it keeps
 * dead and detached sessions so a crashed session is recoverable
 * here, and it dedups a session claimed by several quests to the one
 * its own log names as owner, so the same pane never lists twice.
 * Ordered newest activity first and capped, since this feeds a
 * human picker and a start hint, not an exhaustive audit.
 */
export interface RecentSession {
	questId: string;
	title: string | null;
	sessionId: string;
	status: string;
	liveness: SessionLiveness;
	cwd?: string;
	lastActivity?: string;
}

const RECENT_SESSION_LIMIT = 12;
const SESSION_HINT_LIMIT = 5;

/**
 * A cheap, probe-free pointer to prior sessions for the passive
 * session-start hint. It reads only log activity timestamps and
 * membership, never a process or terminal probe, because the hard
 * rule is that nothing probes history on start. Ordered newest
 * activity first and capped; the authoritative, probed view is
 * `quest recent`.
 */
export interface SessionHint {
	questId: string;
	title: string | null;
	sessionId: string;
	cwd?: string;
	lastActivity?: string;
}

export function recentSessionHints(
	state: QuestState,
	limit = SESSION_HINT_LIMIT,
): SessionHint[] {
	const { index } = discoverQuests(state.questsRoot);
	const logIndex = indexSessionFiles(sessionsDir());
	// One candidate per session with a log, bounded by when its log was
	// last written: no entry can be newer than the write that put it
	// there, give or take clock skew. The first quest to name a session
	// keeps it, as it did when every log was read.
	const candidates = new Map<string, { hint: SessionHint; bound: number }>();
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		for (const session of fm.sessions) {
			if (candidates.has(session.id)) continue;
			const modified = logModifiedAt(logIndex.get(session.id));
			// No log means no activity to point at; skip it rather than
			// list a session the hint cannot date.
			if (modified === undefined) continue;
			candidates.set(session.id, {
				hint: {
					questId: fm.id,
					title: entry.doc.title ?? null,
					sessionId: session.id,
					...(session.cwd ? { cwd: session.cwd } : {}),
				},
				bound: modified + CLOCK_SKEW_MS,
			});
		}
	}
	// Read tails newest-written first, and stop once no remaining log
	// could beat the hints already in hand; with hundreds of sessions
	// recorded, that is a handful of tails rather than all of them.
	const hints: SessionHint[] = [];
	const activity = (h: SessionHint): number => Date.parse(h.lastActivity ?? "");
	for (const { hint, bound } of [...candidates.values()].sort(
		(a, b) => b.bound - a.bound,
	)) {
		const last = hints[limit - 1];
		if (last && activity(last) >= bound) break;
		const lastActivity = activityFromIndex(logIndex, hint.sessionId);
		if (!lastActivity) continue;
		hints.push({ ...hint, lastActivity });
		hints.sort((a, b) => activity(b) - activity(a));
		hints.length = Math.min(hints.length, limit);
	}
	return hints;
}

/**
 * How far a log entry's timestamp may run ahead of its file's mtime and
 * still be found. Both come from this machine's clock, so a minute is
 * generous.
 */
const CLOCK_SKEW_MS = 60_000;

function logModifiedAt(path: string | undefined): number | undefined {
	if (!path) return undefined;
	try {
		return statSync(path).mtimeMs;
	} catch {
		// Listed but gone; the same as having no log.
		return undefined;
	}
}

/** A page of recent sessions, and how many there were in total. */
export interface RecentSessionPage {
	rows: RecentSession[];
	/** How many sessions the registry knows, before the cap. */
	total: number;
}

export async function recentSessions(
	state: QuestState,
	limit = RECENT_SESSION_LIMIT,
): Promise<RecentSessionPage> {
	const { index } = discoverQuests(state.questsRoot);
	// Seed first, so a tab open since before the registry is listed as
	// the open tab it is rather than missing entirely.
	seedLiveSessions(
		[...index.quests.values()].flatMap((entry) =>
			entry.doc.frontMatter.sessions.map((session) => ({
				questId: entry.doc.frontMatter.id,
				session,
			})),
		),
	);
	const stored = loadRecords();
	const { refreshed } = observeRecords(stored);
	const live = new Set(refreshed);
	const now = new Date();
	const titles = new Map(
		[...index.quests.values()].map((entry) => [
			entry.doc.frontMatter.id,
			entry.doc.title ?? null,
		]),
	);
	// One row per record, so a session cannot appear twice. The old
	// listing had to resolve a session claimed by several quests by
	// reading its log; a record names one quest, so the divergence it
	// was resolving cannot be written down in the first place.
	const rows = stored
		.map(({ record, heartbeatAt }) => {
			const isLive = live.has(record.sessionId);
			const when = lastOpenAt(record, { live: isLive, heartbeatAt }, now);
			return {
				questId: record.quest ?? "",
				title: record.quest ? (titles.get(record.quest) ?? null) : null,
				sessionId: record.sessionId,
				status: record.closedAt ? "detached" : "active",
				liveness: livenessOf(record, isLive),
				...(record.cwd ? { cwd: record.cwd } : {}),
				lastActivity: when.at,
			} satisfies RecentSession;
		})
		.sort((a, b) =>
			byRow(a.liveness, a.lastActivity, b.liveness, b.lastActivity),
		);
	return { rows: rows.slice(0, limit), total: rows.length };
}

/**
 * How a record reads to someone looking for a tab to go back to.
 *
 * A session still open but not confirmed alive is idle rather than
 * live: either nothing probeable was captured, or the probe could not
 * say. Neither is evidence of death, and calling it dead is what sent
 * people chasing tabs that were on screen the whole time.
 */
function livenessOf(record: SessionRecord, isLive: boolean): SessionLiveness {
	if (isLive) return "live";
	if (!record.closedAt) return "idle";
	return wasLost(record) ? "dead" : "detached";
}

/** Order rows live-first, then idle, then the rest, newest activity first. */
function byRow(
	aLiveness: SessionLiveness,
	aActivity: string | undefined,
	bLiveness: SessionLiveness,
	bActivity: string | undefined,
): number {
	const rank = livenessRank(aLiveness) - livenessRank(bLiveness);
	if (rank !== 0) return rank;
	const at = aActivity ? Date.parse(aActivity) : 0;
	const bt = bActivity ? Date.parse(bActivity) : 0;
	return bt - at;
}
