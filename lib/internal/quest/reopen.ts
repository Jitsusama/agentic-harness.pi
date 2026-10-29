/**
 * Reopening resolvers for a quest: where to land and which session
 * to resume.
 *
 * Both functions are pure given an existence predicate, so the
 * spawn verb can wire real filesystem checks while tests inject a
 * predicate. The point is that reopening a quest drops you back
 * into the work: a real directory and, when there is one, the live
 * session that was driving it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";
import type { QuestTree } from "../../quest/types.ts";
import type { SessionView } from "./session-liveness.ts";

/** The resolved working directory and how it was chosen. */
export interface ResolvedCwd {
	cwd: string;
	source: "tree" | "session" | "repoRoot" | "home";
	/** True when a recorded candidate was missing and we fell through. */
	healed?: boolean;
}

/**
 * Resolve the working directory to reopen a quest in. Preference
 * order: an existing tree path (newest first), then the most-recent
 * session's cwd, then a tree repoRoot, then the home folder. A
 * recorded path that no longer exists is skipped and the result is
 * flagged as healed so the caller can offer to rewrite the record.
 *
 * It never lands in the quest's own folder, nor in any folder of the
 * quest store, even where an older session ran there: pi started in
 * one finds no repo's AGENTS.md and no project skills, and on
 * 2026-10-25 Joel found every session opened that way working
 * without them. Home is the last resort rather than a refusal, since
 * the desktop launcher opens a quest with no tree the same way, and
 * pi's own skills still load there.
 */
export function resolveSpawnCwd(opts: {
	questDir: string;
	/** The quest store's root; a folder anywhere under it is skipped. */
	store?: string;
	/** The last resort; the user's home folder unless a test names one. */
	home?: string;
	trees: QuestTree[];
	sessions: SessionView[];
	exists?: (p: string) => boolean;
}): ResolvedCwd {
	const exists = opts.exists ?? existsSync;
	const inStore = (p: string) =>
		[opts.questDir, opts.store].some(
			(root) => root !== undefined && (p === root || p.startsWith(root + sep)),
		);
	let healed = false;
	const markMissing = () => {
		healed = true;
	};

	// Newest tree first: the trees array is appended to, so the
	// last entry is the most recently added.
	const trees = [...opts.trees].reverse();
	for (const tree of trees) {
		if (exists(tree.path)) {
			return { cwd: tree.path, source: "tree", ...(healed ? { healed } : {}) };
		}
		markMissing();
	}

	// Most-recent session cwd next. A dead session's cwd is
	// not a signal that work is happening there, so skip it.
	const sessions = [...opts.sessions].sort(byActivityDesc);
	for (const session of sessions) {
		if (!session.cwd || session.liveness === "dead") continue;
		if (inStore(session.cwd)) continue;
		if (exists(session.cwd)) {
			return {
				cwd: session.cwd,
				source: "session",
				...(healed ? { healed } : {}),
			};
		}
		markMissing();
	}

	// A tree's origin repo root, newest first.
	for (const tree of trees) {
		if (tree.repoRoot && exists(tree.repoRoot)) {
			return {
				cwd: tree.repoRoot,
				source: "repoRoot",
				...(healed ? { healed } : {}),
			};
		}
	}

	return {
		cwd: opts.home ?? homedir(),
		source: "home",
		...(healed ? { healed } : {}),
	};
}

/**
 * Choose the session to resume. A live session wins: one live
 * session resumes outright, several live ones are ambiguous
 * (genuinely concurrent work) so the caller can ask which. With
 * no live session, fall back to the most-recent idle one, since
 * reopening yesterday's work is the common case, and staleness is
 * surfaced, not refused. Only dead (no log) and detached sessions
 * are excluded, so undefined means nothing is resumable.
 */
export function pickResumeSession(
	sessions: SessionView[],
): { id: string } | { ambiguous: SessionView[] } | undefined {
	const byLiveness = (want: SessionView["liveness"]): SessionView[] =>
		sessions.filter((s) => s.liveness === want).sort(byActivityDesc);

	const live = byLiveness("live");
	if (live.length === 1) return { id: live[0].id };
	if (live.length > 1) return { ambiguous: live };

	// No live session: resume the most-recent idle one. Idle is
	// stale, not concurrent, so several idle sessions are never
	// ambiguous, and the newest is the one you left the work in.
	const idle = byLiveness("idle");
	if (idle.length > 0) return { id: idle[0].id };
	return undefined;
}

/**
 * The session a closed quest picks up from: its most recently active
 * one that pi saved, when its folder still exists and isn't in the
 * quest store. Detached sessions count, unlike `pickResumeSession`,
 * because a session a power-off or a closed window ended is exactly
 * what reopening means to continue. Undefined when the newest one's
 * folder is gone, rather than reaching back to an older session, whose
 * work is staler still: the caller starts the quest afresh instead.
 *
 * 2026-10-29: the launcher resumed the last README entry not marked
 * detached, which for 19AMVE was a month-old session whose pid had long
 * died and whose folder was gone, and kitty opened it in $HOME.
 */
export function sessionToReopen(opts: {
	questDir: string;
	/** The quest store's root; a folder anywhere under it is skipped. */
	store?: string;
	sessions: SessionView[];
	exists?: (p: string) => boolean;
}): { id: string; cwd: string } | undefined {
	const exists = opts.exists ?? existsSync;
	const inStore = (p: string) =>
		[opts.questDir, opts.store].some(
			(root) => root !== undefined && (p === root || p.startsWith(root + sep)),
		);
	// No activity means pi has no log of it, so there is nothing to resume.
	const newest = [...opts.sessions]
		.filter((session) => session.lastActivity !== undefined)
		.sort(byActivityDesc)[0];
	const cwd = newest?.cwd;
	if (!newest || !cwd || inStore(cwd) || !exists(cwd)) return undefined;
	return { id: newest.id, cwd };
}

/** A session projected for display in the `show` view. */
export interface SessionSummary {
	id: string;
	name?: string;
	cwd?: string;
	liveness: SessionView["liveness"];
	lastActivity?: string;
	/** True for the one session a reopen would resume. */
	resumeTarget: boolean;
}

/**
 * Project a quest's attached sessions for the `show` view. Every
 * attached session is reported, since show reflects the frontmatter
 * honestly, and removing no-log phantoms is the prune verb's job,
 * not this view's. Sessions are ordered newest-activity first, and
 * the single session a reopen would land on (per pickResumeSession)
 * is flagged so the reader can see what `spawn` will resume.
 */
export function summariseSessions(views: SessionView[]): SessionSummary[] {
	const resume = pickResumeSession(views);
	const targetId = resume && "id" in resume ? resume.id : undefined;
	return [...views].sort(byActivityDesc).map((v) => ({
		id: v.id,
		...(v.name ? { name: v.name } : {}),
		...(v.cwd ? { cwd: v.cwd } : {}),
		liveness: v.liveness,
		...(v.lastActivity ? { lastActivity: v.lastActivity } : {}),
		resumeTarget: v.id === targetId,
	}));
}

function byActivityDesc(a: SessionView, b: SessionView): number {
	const at = a.lastActivity ? Date.parse(a.lastActivity) : 0;
	const bt = b.lastActivity ? Date.parse(b.lastActivity) : 0;
	return bt - at;
}
