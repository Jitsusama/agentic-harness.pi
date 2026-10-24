/**
 * A dry run is honoured or refused, never dropped.
 *
 * A caller passing `dryRun: true` is counting on nothing being written.
 * The dispatcher hands each verb the whole params, so a verb that never
 * reads `dryRun` used to act for real: on 23 October a `section` given
 * one replaced a plan's whole Work section, and an `undo` given one
 * reopened a concluded quest. So the actions that preview are listed
 * here, and every other action is refused before its verb runs, which
 * means a verb added later cannot reopen the hole by forgetting.
 *
 * A read is refused too, though it would write nothing: telling the
 * reads from the writes means trusting each verb's account of itself,
 * which is what failed here, and a refused read costs one call.
 *
 * Only `dryRun` is held to this. An ignored `force`, `limit` or `note`
 * does less than the caller asked, or nothing; an ignored `dryRun` does
 * more, and destroys what the caller was trying to keep.
 *
 * An undo's `id` is held to it the same way, since undo reverses the
 * last structural change whatever it is named: see
 * {@link refuseUndoElsewhere}.
 */

import {
	type JournalEntry,
	lastStructuralOp,
} from "../../lib/internal/quest/structural-journal.ts";
import { count } from "../../lib/ui/count.ts";
import { QUEST_ACTIONS } from "./actions.ts";
import {
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./verbs/shared.ts";

/** Every action the tool knows, so an unknown one is left to say so itself. */
const KNOWN: ReadonlySet<string> = new Set(QUEST_ACTIONS);

/**
 * The actions whose verbs read `dryRun`. Conclude and retire honour it
 * only on the sweep's path (quests not loaded here), and refuse it
 * themselves on the others; see {@link refuseSealingDryRun}.
 */
const PREVIEWS: ReadonlySet<string> = new Set([
	"reparent",
	"conclude",
	"retire",
	"spawn",
	"spawn-tab",
	"spawn-pane",
	"spawn-window",
	"restore",
]);

/** What the refusals say previews, so a caller knows where a dry run works. */
const WHAT_PREVIEWS =
	"Only reparent, conclude and retire of quests not loaded here, spawn and restore take a dry run.";

/**
 * The refusal for a call whose action would ignore its `dryRun`, or
 * nothing when the call has none or its action honours it.
 */
export function refuseIgnoredDryRun(
	params: QuestToolParams,
	questsRoot: string,
): QuestResult | undefined {
	if (params.dryRun !== true || PREVIEWS.has(params.action)) return undefined;
	if (!KNOWN.has(params.action)) return undefined;
	if (params.action === "undo") {
		const last = lastStructuralOp(questsRoot);
		const would = last
			? `Called without it, undo would reverse ${undoing(last)}`
			: "Called without it, undo would find nothing to reverse.";
		return refuse(
			`undo has no dry run, so nothing was undone. ${would} Call undo without dryRun only if that is what you want.`,
		);
	}
	return refuse(
		`${params.action} has no dry run and would have acted for real, so nothing was done. Call it without dryRun when you mean it. ${WHAT_PREVIEWS}`,
	);
}

/**
 * The refusal for an undo naming an id the journal's last change did not
 * touch, or nothing. undo reverses that change whatever it is given: on
 * 24 October one given a plan's id, meant for a section write, reopened
 * another session's concluded quest. Only structural changes (status,
 * priority, parent, order and the like) are journalled, so a document's
 * body writes are never undone.
 */
export function refuseUndoElsewhere(
	params: QuestToolParams,
	questsRoot: string,
): QuestResult | undefined {
	const id = params.id?.trim();
	if (params.action !== "undo" || !id) return undefined;
	const last = lastStructuralOp(questsRoot);
	if (!last || last.changes.some((change) => change.id === id)) {
		return undefined;
	}
	return refuse(
		`Nothing was undone: undo reverses only the last structural change, and that one did not touch ${id}. It is ${undoing(last)} Writes by section, journal, tick and untick are not journalled, so undo never reverses them; restore those from a backup. Call undo without an id only if reversing that last change is what you want.`,
	);
}

/** The operation undo would reverse, in a sentence, each quest with its changes. */
function undoing(entry: JournalEntry): string {
	const byQuest = new Map<string, string[]>();
	for (const change of entry.changes) {
		const said = `${change.field} ${change.new ?? "none"} back to ${change.old ?? "none"}`;
		byQuest.set(change.id, [...(byQuest.get(change.id) ?? []), said]);
	}
	const quests = [...byQuest]
		.map(([id, changes]) => `${id} (${changes.join(", ")})`)
		.join("; ");
	return `the ${entry.op} of ${entry.ts}, putting ${count(byQuest.size, "quest")} back, skipping any changed since: ${quests}.`;
}

/**
 * The refusal for a conclude or retire given `dryRun` off the sweep's
 * path, where it would seal `what` for real, or nothing without one.
 */
export function refuseSealingDryRun(
	params: QuestToolParams,
	action: "conclude" | "retire",
	what: string,
): QuestResult | undefined {
	if (params.dryRun !== true) return undefined;
	return refuse(
		`A dry run of ${action} previews only a sweep of quests not loaded here. This would ${action} ${what} for real, so nothing was done. Call it without dryRun when you mean it. ${WHAT_PREVIEWS}`,
	);
}
