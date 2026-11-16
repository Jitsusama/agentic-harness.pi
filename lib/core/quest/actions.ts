/**
 * Canonical verb registry for the quest tool.
 *
 * One source of truth that the schema description and the
 * dispatcher's "unknown action" refusal both read from.
 * Aliases (like `status` for `show`) are listed alongside
 * the canonical names so an agent who reaches for the
 * alias gets routed cleanly, and an agent who types a
 * near-miss gets a Levenshtein-based suggestion.
 */

import { nearestWord } from "../../internal/nearest.ts";

/** Every action name the tool accepts. */
export const QUEST_ACTIONS = [
	"create",
	"load",
	"unload",
	"show",
	"status",
	"config",
	"list",
	"tree",
	"tree-add",
	"tree-adopt",
	"tree-list",
	"tree-release",
	"tree-expand",
	"expand",
	"focus",
	"unfocus",
	"journal",
	"tick",
	"untick",
	"section",
	"think",
	"draft",
	"build",
	"conclude",
	"retire",
	"reopen",
	"promote",
	"demote",
	"drive",
	"park",
	"defer",
	"reclassify",
	"top",
	"bottom",
	"bump",
	"sink",
	"before",
	"after",
	"renumber",
	"reparent",
	"undo",
	"alias-add",
	"alias-remove",
	"session-attach",
	"session-detach",
	"session-rename",
	"spawn",
	"spawn-tab",
	"spawn-pane",
	"spawn-window",
	"find",
	"who",
	"links",
	"locate",
	"ancestors",
	"sessions",
	"recent",
	"reopen-sessions",
	"session-audit",
] as const;

/**
 * Suggest the nearest canonical action to a user's typo by edit
 * distance. Returns `undefined` when no candidate is closer than the
 * cap.
 */
export function suggestAction(typed: string): string | undefined {
	return nearestWord(typed, QUEST_ACTIONS);
}
