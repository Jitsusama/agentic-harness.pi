/**
 * Where this package keeps quests' workspaces: its cache directory,
 * since a workspace holds what a quest can make again or do without,
 * and the backup, Spotlight and the record audit all leave it alone.
 */

import { questWorkspace } from "@jitsusama/agentic-harness.core/quest/workspace";
import { cacheDir } from "../../lib/internal/paths.ts";
import { isId, prefixOf } from "../../lib/internal/quest/id.ts";

/** Where quests' workspaces live, honouring `XDG_CACHE_HOME`. */
export function defaultWorkspaceRoot(): string {
	return cacheDir("quest-workspace");
}

/**
 * A quest's workspace folder, or undefined for an ID that cannot name
 * one, which only a hand-built state has.
 */
export function workspaceDirOf(
	root: string,
	questId: string | null,
): string | undefined {
	if (!questId || !isId(questId) || prefixOf(questId) !== "QEST") return;
	return questWorkspace(root, questId).dir;
}
