/**
 * Liveness derivation for the pi sessions attached to a quest.
 *
 * Liveness is not stored: the persisted {@link QuestSession} shape
 * is unchanged. This module reads the pi session store to classify
 * each attached session by how recently its log was written, so
 * `quest show` and reopening can tell a live session from a dead
 * one without the agent guessing.
 */

import {
	closeSync,
	type Dirent,
	fstatSync,
	openSync,
	readdirSync,
	readSync,
} from "node:fs";
import { join } from "node:path";
import type { QuestSession } from "../../quest/types.js";
import {
	type TerminalProbe,
	type TerminalSessionHandle,
	terminalHandleKey,
} from "../../terminal/types.js";
import type { ProcessIdentity, ProcessProbe } from "./process-liveness.js";

/**
 * How a quest's attached session looks right now.
 *
 * `live` and `dead` are observed through a probe; `unknown` is the
 * honest answer when the probe could not observe; `idle` is the
 * recency fallback for a record that carries no probeable identity;
 * `conflicted` marks a session claimed by more than one quest with no
 * resolvable owner; `detached` is authoritative membership.
 */
export type SessionLiveness =
	| "live"
	| "idle"
	| "detached"
	| "dead"
	| "unknown"
	| "conflicted";

/**
 * A session's ephemeral, read-time probe result. Never persisted.
 * A dimension is present only when the session carries the matching
 * identity, and each dimension is itself tri-state.
 */
export interface SessionObservation {
	process?: ProcessProbe;
	pane?: TerminalProbe;
}

/**
 * Everything the derivation needs, computed once per top-level
 * request: the reference time, each session's last activity, the
 * probe observations for sessions that carry identity, and the set
 * of sessions with unresolved multi-quest ownership. Built by
 * {@link buildLivenessSnapshot} and consumed by {@link deriveLiveness}.
 */
export interface LivenessSnapshot {
	now: Date;
	activity: ReadonlyMap<string, string>;
	observations: ReadonlyMap<string, SessionObservation>;
	conflicted: ReadonlySet<string>;
}

/**
 * Injected dependencies for {@link buildLivenessSnapshot}. Every
 * side effect (reading a log's activity, probing a process, probing
 * terminals) is a function so the snapshot builder never shells out
 * in tests.
 */
export interface LivenessSnapshotDeps {
	now?: Date;
	activityOf: (sessionId: string) => string | undefined;
	probeProcess: (id: ProcessIdentity) => ProcessProbe;
	probeTerminals: (
		handles: readonly TerminalSessionHandle[],
	) => Promise<ReadonlyMap<string, TerminalProbe>>;
	conflicted?: ReadonlySet<string>;
}

/**
 * Render an activity timestamp as a compact relative string
 * ("just now", "15m ago", "3h ago", "2d ago"). Undefined when there
 * is no timestamp or it does not parse, so callers drop the clause
 * rather than print a bare "undefined ago".
 */
export function formatRelativeAge(
	iso: string | undefined,
	now: Date,
): string | undefined {
	if (!iso) return undefined;
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return undefined;
	const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** A {@link QuestSession} enriched with derived liveness. */
export interface SessionView extends QuestSession {
	liveness: SessionLiveness;
	lastActivity?: string;
}

/**
 * A session is live when its log was written within this window;
 * older activity reads as idle. This is a recency heuristic, not a
 * process probe (see the plan's open question on liveness depth).
 */
const LIVE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Drop a quest's no-log phantom sessions. A phantom is a detached
 * session with no log file: a fan-out of ephemeral children leaves
 * such ids behind, and they can never be resumed. Active sessions
 * are never removed (the current one may not have flushed a log
 * yet), and a detached session that still has a log is real history.
 */
export function prunePhantomSessions(
	sessions: QuestSession[],
	hasLog: (id: string) => boolean,
): { kept: QuestSession[]; removed: QuestSession[] } {
	const kept: QuestSession[] = [];
	const removed: QuestSession[] = [];
	for (const session of sessions) {
		if (session.status === "detached" && !hasLog(session.id)) {
			removed.push(session);
		} else {
			kept.push(session);
		}
	}
	return { kept, removed };
}

/**
 * Index every session log in the store once, mapping session id to
 * its file path. Callers that need the activity of many sessions
 * (the activity-window query over the whole backlog) build this
 * once and reuse it, instead of re-listing the store per session.
 */
export function indexSessionFiles(sessionDir: string): Map<string, string> {
	const index = new Map<string, string>();
	const add = (dir: string, names: string[]): void => {
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const underscore = name.lastIndexOf("_");
			if (underscore < 0) continue;
			const id = name.slice(underscore + 1, name.length - ".jsonl".length);
			if (!index.has(id)) index.set(id, join(dir, name));
		}
	};
	let entries: Dirent[];
	try {
		entries = readdirSync(sessionDir, { withFileTypes: true });
	} catch {
		// Store does not exist or is unreadable; an empty index reads
		// the same as "no session has a log".
		return index;
	}
	add(
		sessionDir,
		entries.filter((e) => e.isFile()).map((e) => e.name),
	);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const full = join(sessionDir, entry.name);
		try {
			add(full, readdirSync(full));
		} catch {
			// Unreadable subdir; skip it and keep indexing siblings.
		}
	}
	return index;
}

/**
 * The most recent activity timestamp across a quest's sessions,
 * using a prebuilt {@link indexSessionFiles} map. Undefined when
 * none of them has a log. This is a quest's effective last-touched
 * time for activity-window filtering and sorting.
 */
export function questLastActivity(
	sessions: QuestSession[],
	index: Map<string, string>,
): string | undefined {
	let newest: string | undefined;
	for (const session of sessions) {
		const path = index.get(session.id);
		if (!path) continue;
		const last = newestTimestamp(path);
		if (!last) continue;
		if (!newest || Date.parse(last) > Date.parse(newest)) newest = last;
	}
	return newest;
}

/**
 * Build the read-time snapshot for a set of sessions: record each
 * session's activity, probe every process identity once, and issue
 * one batched terminal probe for the handles that carry a terminal
 * identity. A terminal handle's host is taken from the session's
 * process identity, since a session's terminal lives on the same
 * host as its process. Runs once per request; the derivation over
 * it is synchronous.
 */
export async function buildLivenessSnapshot(
	sessions: readonly QuestSession[],
	deps: LivenessSnapshotDeps,
): Promise<LivenessSnapshot> {
	const now = deps.now ?? new Date();
	const activity = new Map<string, string>();
	const handles: TerminalSessionHandle[] = [];
	for (const session of sessions) {
		const last = deps.activityOf(session.id);
		if (last) activity.set(session.id, last);
		if (session.terminal) {
			handles.push({
				driverId: session.terminal.driverId,
				kind: `${session.terminal.driverId}-pane`,
				hostId: session.process?.hostId ?? "",
				scope: session.terminal.scope,
				value: session.terminal.value,
			});
		}
	}
	const paneProbes =
		handles.length > 0
			? await deps.probeTerminals(handles)
			: new Map<string, TerminalProbe>();
	const observations = new Map<string, SessionObservation>();
	for (const session of sessions) {
		if (!session.process && !session.terminal) continue;
		const obs: SessionObservation = {};
		if (session.process) obs.process = deps.probeProcess(session.process);
		if (session.terminal) {
			const key = terminalHandleKey({
				driverId: session.terminal.driverId,
				kind: `${session.terminal.driverId}-pane`,
				hostId: session.process?.hostId ?? "",
				scope: session.terminal.scope,
				value: session.terminal.value,
			});
			obs.pane = paneProbes.get(key) ?? "unknown";
		}
		observations.set(session.id, obs);
	}
	return {
		now,
		activity,
		observations,
		conflicted: deps.conflicted ?? new Set<string>(),
	};
}

/**
 * Classify an attached session over a prebuilt {@link
 * LivenessSnapshot}. Membership wins first: a detached session reads
 * detached and a conflicted one reads conflicted, whatever a probe
 * saw. A session that carries identity is judged by observation
 * alone (a matching process or a present pane is live; a gone
 * process or an absent pane is dead; anything the probe could not
 * resolve is unknown). A record with no captured identity falls back
 * to the recency window, the only place recency drives liveness.
 */
export function deriveLiveness(
	session: QuestSession,
	snapshot: LivenessSnapshot,
): SessionView {
	const lastActivity = snapshot.activity.get(session.id);
	if (session.status === "detached") {
		return { ...session, liveness: "detached", lastActivity };
	}
	if (snapshot.conflicted.has(session.id)) {
		return { ...session, liveness: "conflicted", lastActivity };
	}
	const observation = snapshot.observations.get(session.id);
	if ((session.process || session.terminal) && observation) {
		return {
			...session,
			liveness: observedLiveness(observation),
			lastActivity,
		};
	}
	if (!lastActivity) return { ...session, liveness: "dead" };
	const age = snapshot.now.getTime() - Date.parse(lastActivity);
	const liveness: SessionLiveness = age <= LIVE_WINDOW_MS ? "live" : "idle";
	return { ...session, liveness, lastActivity };
}

/**
 * Reduce a probe observation to a liveness verdict. The process
 * dimension is authoritative and checked first, so a gone process
 * reads dead even when a stale pane lingers; a present pane rescues
 * a session whose process could not be probed; everything else the
 * probe could not resolve is unknown.
 */
function observedLiveness(observation: SessionObservation): SessionLiveness {
	if (observation.process === "matching") return "live";
	if (observation.process === "gone") return "dead";
	if (observation.pane === "present") return "live";
	if (observation.pane === "absent") return "dead";
	return "unknown";
}

/**
 * Locate a session's log file by id and read its newest activity.
 *
 * Pi stores sessions as `<sessionDir>/<cwd-encoded>/<ts>_<id>.jsonl`,
 * so we scan one level of cwd-encoded subdirectories (and the root,
 * defensively) for a file whose name ends with `_<id>.jsonl`. The
 * newest entry's timestamp is normalized to an ISO string; pi has
 * written both epoch-millisecond numbers and ISO strings over time.
 */
export function sessionActivity(
	id: string,
	sessionDir: string,
): { path: string; lastActivity: string } | undefined {
	const suffix = `_${id}.jsonl`;
	const match = findSessionFile(sessionDir, suffix);
	return activityFromPath(match);
}

/**
 * A session's last activity resolved from a prebuilt {@link
 * indexSessionFiles} map, without re-walking the store. This is the
 * `activityOf` a real {@link buildLivenessSnapshot} passes in.
 */
export function activityFromIndex(
	index: ReadonlyMap<string, string>,
	id: string,
): string | undefined {
	return activityFromPath(index.get(id))?.lastActivity;
}

/**
 * Read a known log path's newest activity. Shared by the
 * directory-walk and the prebuilt-index resolution paths so both
 * report activity identically. Undefined when the path is missing
 * or carries no parseable timestamp.
 */
function activityFromPath(
	path: string | undefined,
): { path: string; lastActivity: string } | undefined {
	if (!path) return undefined;
	const lastActivity = newestTimestamp(path);
	if (!lastActivity) return undefined;
	return { path, lastActivity };
}

/** Walk the session dir and its immediate subdirs for the id-matched file. */
function findSessionFile(
	sessionDir: string,
	suffix: string,
): string | undefined {
	let entries: Dirent[];
	try {
		entries = readdirSync(sessionDir, { withFileTypes: true });
	} catch {
		// Session dir does not exist or is unreadable; the caller
		// treats this the same as "no session file found".
		return undefined;
	}
	for (const entry of entries) {
		const full = join(sessionDir, entry.name);
		if (entry.isFile() && entry.name.endsWith(suffix)) return full;
		if (entry.isDirectory()) {
			let inner: string[];
			try {
				inner = readdirSync(full);
			} catch {
				// Unreadable subdir; skip it and keep scanning siblings.
				continue;
			}
			const hit = inner.find((name) => name.endsWith(suffix));
			if (hit) return join(full, hit);
		}
	}
	return undefined;
}

/**
 * How much of a session log's tail to read for its newest
 * timestamp. Logs are append-only and can grow large, so reading
 * the whole file just to find the latest entry is wasteful; the
 * last window holds the recent entries.
 */
const TAIL_BYTES = 64 * 1024;

/**
 * Read the newest entry's timestamp from a JSONL session file.
 *
 * Reads only the tail rather than the whole file, and returns the
 * maximum timestamp among the lines it reads rather than the last
 * positional one, so a late-arriving out-of-order entry does not
 * mis-report activity.
 */
function newestTimestamp(path: string): string | undefined {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		// File vanished between listing and reading; no activity.
		return undefined;
	}
	try {
		const { size } = fstatSync(fd);
		const start = Math.max(0, size - TAIL_BYTES);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		if (length > 0) readSync(fd, buffer, 0, length, start);
		let text = buffer.toString("utf8");
		// When we started mid-file the first line is likely partial;
		// drop it so a truncated JSON line is not parsed.
		if (start > 0) {
			const newline = text.indexOf("\n");
			if (newline >= 0) text = text.slice(newline + 1);
		}
		let newest: string | undefined;
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			const stamp = parseTimestamp(trimmed);
			if (stamp && (!newest || Date.parse(stamp) > Date.parse(newest))) {
				newest = stamp;
			}
		}
		return newest;
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** Parse one JSONL line's timestamp into an ISO string. */
function parseTimestamp(line: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		// A partially written final line; fall back to an earlier one.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const raw = (parsed as Record<string, unknown>).timestamp;
	if (typeof raw === "number") return new Date(raw).toISOString();
	if (typeof raw === "string") {
		const ms = Date.parse(raw);
		if (!Number.isNaN(ms)) return new Date(ms).toISOString();
	}
	return undefined;
}
