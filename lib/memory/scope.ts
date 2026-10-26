/**
 * A fact's scope: which one applies now, and the single string key
 * it is stored under, so recall is a plain lookup. This is the only
 * place that key is minted.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLastEntry } from "../internal/state.ts";
import type { Scope } from "./types.ts";

/** The canonical string key for a scope. */
export function serializeScope(scope: Scope): string {
	switch (scope.kind) {
		case "global":
			return "global";
		case "project":
			return `project:${scope.path}`;
		case "quest":
			return `quest:${scope.id}`;
	}
}

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
