/**
 * Structural verbs: reparent (single or bulk). These move
 * quests within the tree under an explicit scope, offer a
 * dry-run preview and report exactly what changed, so a cleanup
 * can be trusted and reversed.
 */

import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.js";
import {
	discoverQuests,
	siblingRanks,
} from "../../../lib/internal/quest/discovery.js";
import { nextRank } from "../../../lib/internal/quest/ranking.js";
import { isSealedStatus } from "../../../lib/internal/quest/status.js";
import {
	planReparent,
	planStatusChange,
} from "../../../lib/internal/quest/structural.js";
import {
	dropLastStructuralOp,
	type JournalChange,
	lastStructuralOp,
	recordStructuralOp,
} from "../../../lib/internal/quest/structural-journal.js";
import type { QuestFrontMatter } from "../../../lib/quest/index.js";
import {
	sealQuestDocuments,
	setQuestKindByDir,
	setQuestParent,
	setQuestPriorityByDir,
	setQuestRankByDir,
	setQuestStatusByDir,
} from "../lifecycle.js";
import type { QuestState } from "../state.js";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.js";

/**
 * Reparent one or more quests under a new parent (or to top
 * level with `parent: null`). The whole batch is atomic: if any
 * target is missing or would form a cycle, nothing is written.
 * With `dryRun`, the plan is returned without any writes.
 */
export function reparent(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const targets = (params.id ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	if (targets.length === 0) {
		return refuse(
			"Pass the quest id(s) to move in `id` (comma-separated for a batch).",
		);
	}
	if (params.parent === undefined) {
		return refuse(
			"Pass the new `parent` quest id, or `null` to move to top level.",
		);
	}
	const newParent = params.parent === "null" ? null : params.parent.trim();

	const { index } = discoverQuests(state.questsRoot);
	const plan = planReparent(index, targets, newParent);
	if (plan.errors.length > 0) {
		return refuse(
			`Refusing the batch; nothing was moved:\n- ${plan.errors.join("\n- ")}`,
		);
	}
	if (plan.changes.length === 0) {
		return ok("Nothing to reparent; every target is already there.", {
			changes: [],
			dryRun: Boolean(params.dryRun),
		});
	}

	if (params.dryRun) {
		const lines = plan.changes
			.map(
				(c) =>
					`  ${c.id}: ${c.oldParent ?? "top level"} -> ${c.newParent ?? "top level"}`,
			)
			.join("\n");
		return ok(
			`Dry run: would reparent ${plan.changes.length} quest(s).\n${lines}`,
			{ changes: plan.changes, dryRun: true },
		);
	}

	// Journal incrementally: record each write the moment it lands so
	// a mid-batch failure leaves the journal reflecting exactly what
	// is on disk, and undo can reverse the partial application.
	//
	// A moved quest leaves its old sibling set and joins a new one, so
	// its old rank can collide there. Place it at the next free rank in
	// the destination (parent, priority) group and journal the rank
	// change too, so undo restores both. `taken` tracks ranks claimed
	// this batch so several quests moved into the same group get
	// distinct ranks rather than all landing on the same next free one.
	const applied: JournalChange[] = [];
	const takenByGroup = new Map<string, Set<number>>();
	const placeRank = (parent: string | null, priority: string): number => {
		const key = `${parent ?? ""}\u0000${priority}`;
		let taken = takenByGroup.get(key);
		if (!taken) {
			taken = new Set(siblingRanks(index, parent, priority));
			takenByGroup.set(key, taken);
		}
		const rank = nextRank([...taken]);
		taken.add(rank);
		return rank;
	};
	for (const change of plan.changes) {
		const entry = index.quests.get(change.id);
		if (!entry) continue;
		const result = setQuestParent(entry.dir, change.newParent);
		if (!result.ok) {
			if (applied.length > 0) {
				recordStructuralOp(state.questsRoot, "reparent", applied);
			}
			return refuse(
				`${result.guidance} Applied ${applied.length} of ${plan.changes.length} before the failure; recorded for undo.`,
			);
		}
		applied.push({
			id: change.id,
			field: "parent",
			old: change.oldParent,
			new: change.newParent,
		});
		const priority = entry.doc.frontMatter.priority;
		const oldRank = entry.doc.frontMatter.rank;
		const newRank = placeRank(change.newParent, priority);
		if (newRank !== oldRank) {
			const rankResult = setQuestRankByDir(entry.dir, newRank);
			if (!rankResult.ok) {
				recordStructuralOp(state.questsRoot, "reparent", applied);
				return refuse(
					`${rankResult.guidance} Applied ${applied.length} change(s) before the failure; recorded for undo.`,
				);
			}
			applied.push({
				id: change.id,
				field: "rank",
				old: String(oldRank),
				new: String(newRank),
			});
		}
	}
	recordStructuralOp(state.questsRoot, "reparent", applied);
	return ok(`Reparented ${plan.changes.length} quest(s).`, {
		changes: plan.changes,
		dryRun: false,
	});
}

/**
 * Reverse the most recent structural operation, restoring each
 * quest's recorded old value. Refuses when the journal is empty.
 */
/**
 * Bulk conclude or retire an explicit comma-separated id set.
 * Atomic on any missing target, dry-run previewable, journalled
 * for undo. Unlike the single-quest conclude, this does not
 * prune trees: it is a lightweight, reversible status sweep.
 */
export function bulkConcludeOrRetire(
	state: QuestState,
	action: "conclude" | "retire",
	params: QuestToolParams,
): QuestResult {
	const targets = (params.id ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	if (targets.length === 0) {
		return refuse("Pass the quest ids to sweep in `id`, comma-separated.");
	}
	const reason = params.reason?.trim();
	if (action === "retire" && !reason) {
		return refuse(
			"Bulk retire needs a `reason`: why are these being abandoned?",
		);
	}
	const newStatus = action === "conclude" ? "concluded" : "retired";

	const { index } = discoverQuests(state.questsRoot);
	const plan = planStatusChange(index, targets, newStatus);
	if (plan.errors.length > 0) {
		return refuse(
			`Refusing the batch; nothing was changed:\n- ${plan.errors.join("\n- ")}`,
		);
	}
	if (plan.changes.length === 0) {
		return ok(`Nothing to ${action}; every target is already ${newStatus}.`, {
			changes: [],
			dryRun: Boolean(params.dryRun),
		});
	}

	if (params.dryRun) {
		const lines = plan.changes
			.map((c) => `  ${c.id}: ${c.oldStatus} -> ${c.newStatus}`)
			.join("\n");
		return ok(
			`Dry run: would ${action} ${plan.changes.length} quest(s).\n${lines}`,
			{ changes: plan.changes, dryRun: true },
		);
	}

	const journey =
		action === "conclude"
			? "Concluded the quest (bulk)."
			: `Retired the quest (bulk): ${reason}.`;
	const applied: JournalChange[] = [];
	for (const change of plan.changes) {
		const entry = index.quests.get(change.id);
		if (!entry) continue;
		const result = setQuestStatusByDir(
			entry.dir,
			newStatus as QuestFrontMatter["status"],
		);
		if (!result.ok) {
			if (applied.length > 0) {
				recordStructuralOp(state.questsRoot, action, applied);
			}
			return refuse(
				`${result.guidance} Applied ${applied.length} of ${plan.changes.length} before the failure; recorded for undo.`,
			);
		}
		// Cascade the seal the same way the loaded-quest path does: drop
		// the priority to someday (journalled, so undo restores it) and
		// seal every still-active document to the terminal stage.
		const oldPriority = entry.doc.frontMatter.priority;
		if (oldPriority !== "someday") {
			setQuestPriorityByDir(entry.dir, "someday");
			applied.push({
				id: change.id,
				field: "priority",
				old: oldPriority,
				new: "someday",
			});
		}
		sealQuestDocuments(entry.dir, newStatus as "concluded" | "retired");
		appendJourneyByPath(entry.dir, journey);
		applied.push({
			id: change.id,
			field: "status",
			old: change.oldStatus,
			new: change.newStatus,
		});
	}
	recordStructuralOp(state.questsRoot, action, applied);
	// A sealed quest with live children leaves them orphaned but live.
	// Warn rather than cascade: the operator chose these ids, so seal
	// only what was named and surface the children to decide on next.
	const sealedIds = new Set(plan.changes.map((c) => c.id));
	const liveChildren: string[] = [];
	for (const id of sealedIds) {
		for (const childId of index.children.get(id) ?? []) {
			const child = index.quests.get(childId);
			if (child && !isSealedStatus(child.doc.frontMatter.status)) {
				liveChildren.push(childId);
			}
		}
	}
	const warning =
		liveChildren.length > 0
			? ` Warning: ${liveChildren.length} live child quest(s) remain under a sealed parent: ${liveChildren.join(", ")}.`
			: "";
	return ok(
		`${action === "conclude" ? "Concluded" : "Retired"} ${plan.changes.length} quest(s).${warning}`,
		{
			changes: plan.changes,
			dryRun: false,
			liveChildren,
		},
	);
}

/**
 * Read the current on-disk value of a journalled field, so undo can
 * check it still equals what the operation wrote before reverting.
 */
function currentValue(
	fm: QuestFrontMatter,
	field: JournalChange["field"],
): string | null {
	switch (field) {
		case "parent":
			return fm.parent ?? null;
		case "priority":
			return fm.priority;
		case "status":
			return fm.status;
		case "rank":
			return String(fm.rank);
		case "kind":
			return fm.kind;
		default:
			// The field type is wider than the fields undo can reverse
			// (stage is journallable but lives on a document, not the
			// quest README this reverses). Return a sentinel that can
			// never equal the recorded `new`, so the change is skipped
			// and preserved in the journal rather than mis-reverted.
			return UNREVERTABLE_FIELD;
	}
}

/**
 * A value no real front-matter field can hold, used to force an
 * unhandled journalled field down undo's skip-and-preserve path.
 */
const UNREVERTABLE_FIELD = "\u0000__unrevertable_field__";

/** Reverse a single journalled change, restoring its recorded old value. */
function revertField(
	dir: string,
	change: JournalChange,
): { ok: true } | { ok: false; guidance: string } {
	switch (change.field) {
		case "parent":
			return setQuestParent(dir, change.old);
		case "priority":
			return setQuestPriorityByDir(
				dir,
				change.old as QuestFrontMatter["priority"],
			);
		case "status":
			return setQuestStatusByDir(dir, change.old as QuestFrontMatter["status"]);
		case "rank":
			return setQuestRankByDir(dir, Number(change.old));
		case "kind":
			return setQuestKindByDir(dir, change.old as QuestFrontMatter["kind"]);
		default:
			// Unreachable for today's journalled ops: currentValue skips an
			// unhandled field before revertField is ever called for it. Kept
			// as a defensive refusal so a future field that starts being
			// journalled cannot silently corrupt the status field.
			return {
				ok: false,
				guidance: `undo cannot reverse a ${change.field} change yet.`,
			};
	}
}

export function undo(state: QuestState): QuestResult {
	const last = lastStructuralOp(state.questsRoot);
	if (!last) {
		return refuse("Nothing to undo; the structural journal is empty.");
	}
	const { index } = discoverQuests(state.questsRoot);
	const skipped: string[] = [];
	const skippedChanges: JournalChange[] = [];
	const reverted: string[] = [];
	for (const change of last.changes) {
		const entry = index.quests.get(change.id);
		if (!entry) {
			skipped.push(change.id);
			skippedChanges.push(change);
			continue;
		}
		// Verify the on-disk value still equals what this operation
		// wrote. An intervening manual edit means the recorded `new` no
		// longer holds, so reverting to `old` would clobber that edit;
		// skip instead.
		const current = currentValue(entry.doc.frontMatter, change.field);
		if (current !== change.new) {
			skipped.push(change.id);
			skippedChanges.push(change);
			continue;
		}
		const result = revertField(entry.dir, change);
		if (!result.ok) return refuse(result.guidance);
		// setQuestParent appends its own "Reparented to ..." line; a
		// status reversal needs an explicit compensating entry so the
		// original conclude/retire line does not stand uncontradicted.
		if (change.field === "status") {
			appendJourneyByPath(entry.dir, `Reverted the ${last.op} (undo).`);
		}
		reverted.push(change.id);
	}
	// Consume the op, but keep the changes we could not apply: rewrite
	// the journal so the skipped changes survive as the operation's
	// residue. A later undo can reverse them once the divergence
	// resolves, instead of the partial undo swallowing them for good.
	dropLastStructuralOp(state.questsRoot);
	if (skippedChanges.length > 0) {
		recordStructuralOp(state.questsRoot, last.op, skippedChanges);
	}
	const note =
		skipped.length > 0
			? ` (skipped ${skipped.length} quest(s) missing or changed since: ${skipped.join(", ")})`
			: "";
	return ok(`Undid ${last.op} of ${reverted.length} quest(s)${note}.`, {
		op: last.op,
		changes: last.changes,
		reverted,
		skipped,
	});
}
