/**
 * Front matter fields the quest workflow owns, and the verb that
 * changes each.
 *
 * A hand edit that changes one of these leaves the workflow's own
 * picture of the quest wrong: it holds the focused document's stage in
 * memory, so an edited `stage:` is overwritten by the next transition,
 * and an edited `status:` skips everything a seal does (trees, priority,
 * documents, the journal undo reads). Refusing the edit and naming the
 * verb costs one retry; allowing it costs a quest that reads one way on
 * disk and behaves another.
 */

import { splitAtBody } from "./body-edits.ts";

/** Which kind of quest file a path is. */
export type QuestFileKind = "readme" | "document";

/** Owned fields, by file, with the verb that changes each. */
const OWNED: Record<QuestFileKind, Record<string, string>> = {
	readme: {
		id: "nothing: a quest's id never changes",
		kind: "`reclassify`",
		status: "`conclude`, `retire` or `reopen`",
	},
	document: {
		id: "nothing: a document's id never changes",
		kind: "`draft` with a kind, before the id is minted",
		quest: "nothing: a document belongs to the quest it was drafted in",
		stage: "`think`, `draft`, `build`, `conclude` or `retire`",
	},
};

/** An owned field a write would change, and where to change it instead. */
export interface OwnedFieldChange {
	field: string;
	from: string | undefined;
	to: string | undefined;
	verb: string;
}

/**
 * The owned fields `after` changes relative to `before`. A file that
 * had no front matter to begin with owns nothing yet.
 */
export function ownedFieldChanges(
	kind: QuestFileKind,
	before: string,
	after: string,
): OwnedFieldChange[] {
	const was = topLevelScalars(before);
	if (was.size === 0) return [];
	const now = topLevelScalars(after);
	return Object.entries(OWNED[kind]).flatMap(([field, verb]) => {
		const from = was.get(field);
		const to = now.get(field);
		return from === to ? [] : [{ field, from, to, verb }];
	});
}

/**
 * Apply an edit tool's replacements to a text, as the edit tool would:
 * each old text must appear exactly once. Undefined when one does not,
 * since the edit tool refuses that call on its own.
 */
export function applyEdits(
	text: string,
	edits: readonly { oldText: string; newText: string }[],
): string | undefined {
	let result = text;
	for (const { oldText, newText } of edits) {
		const at = text.indexOf(oldText);
		if (at === -1 || text.indexOf(oldText, at + 1) !== -1) return undefined;
		// Matched against the original, as the edit tool matches them.
		if (!result.includes(oldText)) return undefined;
		result = result.replace(oldText, () => newText);
	}
	return result;
}

/** The top-level `key: value` lines of a text's front matter. */
function topLevelScalars(text: string): Map<string, string> {
	const { head } = splitAtBody(text);
	const values = new Map<string, string>();
	for (const line of head.split("\n")) {
		const match = /^([A-Za-z][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
		if (match) values.set(match[1], unquote(match[2]));
	}
	return values;
}

function unquote(value: string): string {
	const quoted = /^(["'])(.*)\1$/.exec(value);
	return quoted ? quoted[2] : value;
}
