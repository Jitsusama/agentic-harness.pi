/**
 * A quest's workspace, under the root `lib/internal/quest/workspace-root.ts`
 * names.
 */

import { questWorkspace } from "@jitsusama/agentic-harness.core/quest/workspace";
import { isId, prefixOf } from "../../lib/internal/quest/id.ts";
import { questWorkspacesRoot } from "../../lib/internal/quest/workspace-root.ts";

/** Where quests' workspaces live, honouring `XDG_CACHE_HOME`. */
export const defaultWorkspaceRoot = questWorkspacesRoot;

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
