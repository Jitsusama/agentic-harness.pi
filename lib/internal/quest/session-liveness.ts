/**
 * Liveness derivation for the pi sessions attached to a quest.
 *
 * Liveness is not stored: the persisted {@link QuestSession} shape
 * is unchanged. This module reads the pi session store to classify
 * each attached session by how recently its log was written, so
 * `quest show` and reopening can tell a live session from a dead
 * one without the agent guessing.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QuestSession } from "../../quest/types.js";

/** How a quest's attached session looks right now. */
export type SessionLiveness = "live" | "idle" | "detached" | "dead";

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
 * Classify an attached session. A detached status wins outright; a
 * session with no log file is dead; recent activity is live and
 * older activity is idle. lastActivity is carried through whenever
 * a log file is found, even for a detached session.
 */
export function deriveLiveness(
	session: QuestSession,
	sessionDir: string,
	now: Date,
): SessionView {
	const activity = sessionActivity(session.id, sessionDir);
	const lastActivity = activity?.lastActivity;
	if (session.status === "detached") {
		return { ...session, liveness: "detached", lastActivity };
	}
	if (!activity) return { ...session, liveness: "dead" };
	const age = now.getTime() - Date.parse(activity.lastActivity);
	const liveness: SessionLiveness = age <= LIVE_WINDOW_MS ? "live" : "idle";
	return { ...session, liveness, lastActivity };
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
	if (!match) return undefined;
	const lastActivity = newestTimestamp(match);
	if (!lastActivity) return undefined;
	return { path: match, lastActivity };
}

/** Walk the session dir and its immediate subdirs for the id-matched file. */
function findSessionFile(
	sessionDir: string,
	suffix: string,
): string | undefined {
	let entries: ReturnType<typeof readdirSync>;
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

/** Read the newest entry's timestamp from a JSONL session file. */
function newestTimestamp(path: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// File vanished between listing and reading; treat as no activity.
		return undefined;
	}
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i].trim();
		if (line === "") continue;
		const stamp = parseTimestamp(line);
		if (stamp) return stamp;
	}
	return undefined;
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
