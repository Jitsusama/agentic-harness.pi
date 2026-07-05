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
	"tree-prune",
	"tree-expand",
	"expand",
	"focus",
	"unfocus",
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
	"spawn-tab",
	"spawn-pane",
	"spawn-window",
	"find",
	"who",
	"links",
	"locate",
] as const;

/** Static type of any canonical action. */
export type QuestAction = (typeof QUEST_ACTIONS)[number];

/**
 * Suggest the nearest canonical action to a user's typo
 * using Levenshtein distance. Returns `undefined` when no
 * candidate is closer than the cap.
 */
export function suggestAction(typed: string): string | undefined {
	const cap = Math.max(2, Math.floor(typed.length / 2));
	let best: { action: string; distance: number } | undefined;
	for (const action of QUEST_ACTIONS) {
		const distance = levenshtein(typed, action);
		if (distance > cap) continue;
		if (!best || distance < best.distance) {
			best = { action, distance };
		}
	}
	return best?.action;
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	const prev: number[] = new Array(b.length + 1);
	const curr: number[] = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
	}
	return prev[b.length];
}
