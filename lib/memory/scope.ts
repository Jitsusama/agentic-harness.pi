/**
 * Scope resolution and serialization. A fact's scope is
 * stored as a single string key so recall is a plain lookup;
 * these helpers are the only place that shape is minted.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getLastEntry } from "../internal/state.js";
import type { Scope } from "./types.js";

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
