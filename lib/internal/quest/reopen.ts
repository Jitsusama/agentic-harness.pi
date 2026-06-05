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
 * Choose the live session to resume. Returns undefined when none
 * is live, the single live session's id when exactly one is, and
 * an ambiguous list (most-recent first) when several are live so
 * the caller can ask the user which to resume.
 */
export function pickResumeSession(
	sessions: SessionView[],
): { id: string } | { ambiguous: SessionView[] } | undefined {
	const live = sessions
		.filter((s) => s.liveness === "live")
		.sort(byActivityDesc);
	if (live.length === 0) return undefined;
	if (live.length === 1) return { id: live[0].id };
	return { ambiguous: live };
}

function byActivityDesc(a: SessionView, b: SessionView): number {
	const at = a.lastActivity ? Date.parse(a.lastActivity) : 0;
	const bt = b.lastActivity ? Date.parse(b.lastActivity) : 0;
	return bt - at;
}
