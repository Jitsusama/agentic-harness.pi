/**
 * Resolving which scope currently applies. This is pi-specific
 * (it reads pi's own session log for a loaded quest); scope
 * serialization itself lives in core (`lib/core/memory`) and is
 * re-exported from ./index.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Scope } from "../core/memory/index.ts";
import { getLastEntry } from "../internal/state.ts";

/**
 * Resolve the active scope for the current session: the loaded
 * quest when one is loaded, otherwise the project at the
 * current working directory.
 */
export function resolveScope(ctx: ExtensionContext): Scope {
	const quest = getLastEntry<{ questId?: string | null }>(
		ctx,
		"quest-workflow",
	);
	if (quest?.questId) return { kind: "quest", id: quest.questId };
	return { kind: "project", path: ctx.cwd };
}
