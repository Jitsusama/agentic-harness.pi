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
	// One row of the table at a time, walking the row above in step:
	// `diagonal` is the cell above and to the left, `left` the one just
	// filled, and the last cell filled is the distance.
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	let left = b.length;
	for (let i = 1; i <= a.length; i++) {
		const curr = [i];
		let diagonal = i - 1;
		left = i;
		for (const [j, above] of prev.slice(1).entries()) {
			const cost = a[i - 1] === b[j] ? 0 : 1;
			left = Math.min(left + 1, above + 1, diagonal + cost);
			curr.push(left);
			diagonal = above;
		}
		prev = curr;
	}
	return left;
}
