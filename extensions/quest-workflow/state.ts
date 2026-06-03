/**
 * Runtime state for the quest workflow. Two layers:
 *
 * 1. The loaded quest: which campaign we're currently in.
 *    There can be at most one at a time.
 * 2. The focused document: which plan, research, brief or
 *    report under that quest the agent is currently driving
 *    through the stage machine. At most one at a time.
 *
 * Both layers are caches derived from disk. The quest README
 * and the focused document are the real sources of truth;
 * the state holds enough projection to drive the status bar
 * and the discipline gates without re-reading on every turn.
 */

import { join } from "node:path";
import type {
	DocumentKind,
	QuestKind,
	QuestPriority,
	QuestStatus,
} from "../../lib/quest/types.js";
import type { Stage } from "./machine.js";

/** Runtime state for the loaded quest and focused document. */
export interface QuestState {
	/**
	 * Where the quest tree lives on disk. Settled at
	 * extension startup; the user changes it through the
	 * config file.
	 */
	questsRoot: string;

	/** Absolute path to the loaded quest's directory. */
	questDir: string | null;
	/** The loaded quest's id (QEST-...). */
	questId: string | null;
	/** The loaded quest's title (H1). */
	questTitle: string | null;
	/** The loaded quest's kind. */
	questKind: QuestKind | null;
	/** The loaded quest's status. */
	questStatus: QuestStatus | null;
	/** The loaded quest's priority bucket. */
	questPriority: QuestPriority | null;

	/** Focused document path under the loaded quest, when one is focused. */
	documentPath: string | null;
	/** Focused document id (PLAN-/RSCH-/BRIF-/RPRT-...). */
	documentId: string | null;
	/** Focused document kind. */
	documentKind: DocumentKind | null;
	/** Focused document title (H1). */
	documentTitle: string | null;
	/** Focused document stage. */
	documentStage: Stage;

	/**
	 * Progress for the status bar. When a document is
	 * focused, these mirror that document's checkboxes.
	 * Otherwise they mirror the quest's Milestones section.
	 */
	done: number;
	total: number;
}

/**
 * Build a fresh, idle state. The questsRoot is taken from
 * `QUEST_WORKFLOW_ROOT` when set, otherwise the per-package
 * XDG data dir. Callers pass the home directory so the
 * default does not need a process-wide side-effect.
 */
export function createQuestState(opts: {
	homeDir: string;
	dataDir: string;
}): QuestState {
	const override = process.env.QUEST_WORKFLOW_ROOT;
	const root =
		override && override.length > 0 ? override : join(opts.dataDir, "quests");
	return {
		questsRoot: root,
		questDir: null,
		questId: null,
		questTitle: null,
		questKind: null,
		questStatus: null,
		questPriority: null,
		documentPath: null,
		documentId: null,
		documentKind: null,
		documentTitle: null,
		documentStage: "idle",
		done: 0,
		total: 0,
	};
}

/**
 * Bash commands that mutate code or repo state, blocked
 * while in think or draft on a plan.
 *
 * This is agent discipline, not a sandbox: it nudges the
 * agent toward the right phase rather than enforcing
 * security. A determined caller can always bypass through
 * a tool we haven't pattern-matched on. The patterns cover
 * the common-case write paths an agent reaches for
 * accidentally.
 *
 * The git regex tolerates global options between `git`
 * and the verb (`-c k=v`, `-C path`, `--git-dir=...`,
 * `--work-tree=...`) so a `git -c user.email=...` form
 * does not slip past.
 */
export const GIT_MUTATING =
	/\bgit(?:\s+(?:-c\s+\S+|-C\s+\S+|--git-dir=\S+|--work-tree=\S+|--no-pager))*\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|switch|restore|am|format-patch)\b/i;

/**
 * Bash patterns that write to the filesystem outside the
 * quest tree. Same advisory contract as GIT_MUTATING: a
 * nudge toward the focused stage, not a security boundary.
 * The agent uses the pi `write`/`edit` tools for normal
 * code edits; bash redirection is the path that escaped
 * the discipline before.
 */
export const BASH_WRITE_PATTERNS = [
	/(^|\s|[;&|`])cat\s+[^|]*>>?\s/, // cat > foo, cat >> foo
	/(^|\s|[;&|`])tee\s+(?:-[a-z]+\s+)*\S/, // tee foo, tee -a foo
	/(^|\s|[;&|`])sed\s+(?:-[a-z]+\s+)*-i\b/, // sed -i
	/(^|\s|[;&|`])gsed\s+(?:-[a-z]+\s+)*-i\b/, // homebrew sed
	/(^|\s|[;&|`])perl\s+(?:-[a-z]+\s+)*-i\b/, // perl -i
	/(^|\s|[;&|`])printf\s+.+>>?\s/, // printf > foo
	/(^|\s|[;&|`])echo\s+.+>>?\s/, // echo > foo
];
