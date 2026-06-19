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
import type { QuestTree } from "../../quest/types.js";
import type { SessionView } from "./session-liveness.js";

/** The resolved working directory and how it was chosen. */
export interface ResolvedCwd {
	cwd: string;
	source: "tree" | "session" | "repoRoot" | "questDir";
	/** True when a recorded candidate was missing and we fell through. */
	healed?: boolean;
}

/**
 * Resolve the working directory to reopen a quest in. Preference
 * order: an existing tree path (newest first), then the most-recent
 * session's cwd, then a tree repoRoot, then the quest dir. A
 * recorded path that no longer exists is skipped and the result is
 * flagged as healed so the caller can offer to rewrite the record.
 */
export function resolveSpawnCwd(opts: {
	questDir: string;
	trees: QuestTree[];
	sessions: SessionView[];
	exists?: (p: string) => boolean;
}): ResolvedCwd {
	const exists = opts.exists ?? existsSync;
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
		cwd: opts.questDir,
		source: "questDir",
		...(healed ? { healed } : {}),
	};
}

/**
 * Choose the session to resume. A live session wins: one live
 * session resumes outright, several live ones are ambiguous
 * (genuinely concurrent work) so the caller can ask which. With
 * no live session, fall back to the most-recent idle one —
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
	// ambiguous — the newest is the one you left the work in.
	const idle = byLiveness("idle");
	if (idle.length > 0) return { id: idle[0].id };
	return undefined;
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
 * attached session is reported — show reflects the frontmatter
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
