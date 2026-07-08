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
	/**
	 * The loaded quest's verification command, or null when it
	 * declares none. Mirrored from the quest frontmatter so the
	 * verification workflow can read it from this session entry
	 * without parsing the quest itself.
	 */
	questVerify: string | null;

	/**
	 * The loaded quest's managed scratch directory, or null when it
	 * has none yet. Created on demand under the OS temp dir, recorded
	 * on the quest frontmatter and mirrored here so the gate can
	 * classify scratch writes without a disk read. Reaped on conclude
	 * and retire.
	 */
	scratchDir: string | null;

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
	 * Otherwise they mirror the quest README's checkboxes.
	 */
	done: number;
	total: number;
	/**
	 * Verbatim prose of the first unchecked checkbox in the
	 * source the counter walked. Carried so the widget can
	 * paint `→ {item}` without re-parsing the body.
	 */
	currentItem?: string;

	/**
	 * Cache of the most recently persisted snapshot's
	 * `${questId ?? ""}|${documentPath ?? ""}` key. The
	 * tool_result hook fires on every tool call; comparing
	 * against this cache is O(1) and avoids reading the
	 * session history from disk to dedup. The cache is
	 * advisory: when it's missing (a fresh session), the
	 * dedup path falls back to `getLastEntry`.
	 */
	lastPersistedKey?: string;
}

/**
 * Build a fresh, idle state. The caller resolves the
 * questsRoot from the package config (see
 * `resolveQuestsRoot` in config.ts) and passes it in, so
 * this stays a pure constructor with no environment or
 * filesystem side-effects.
 */
export function createQuestState(opts: { questsRoot: string }): QuestState {
	return {
		questsRoot: opts.questsRoot,
		questDir: null,
		questId: null,
		questTitle: null,
		questKind: null,
		questStatus: null,
		questPriority: null,
		questVerify: null,
		scratchDir: null,
		documentPath: null,
		documentId: null,
		documentKind: null,
		documentTitle: null,
		documentStage: "idle",
		done: 0,
		total: 0,
		currentItem: undefined,
		lastPersistedKey: undefined,
	};
}
