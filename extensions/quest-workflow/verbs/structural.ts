/**
 * Structural verbs: reparent (single or bulk). These move
 * quests within the tree under an explicit scope, offer a
 * dry-run preview and report exactly what changed, so a cleanup
 * can be trusted and reversed.
 */

import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.js";
import { discoverQuests } from "../../../lib/internal/quest/discovery.js";
import {
	planReparent,
	planStatusChange,
} from "../../../lib/internal/quest/structural.js";
import {
	dropLastStructuralOp,
	lastStructuralOp,
	recordStructuralOp,
} from "../../../lib/internal/quest/structural-journal.js";
import type { QuestFrontMatter } from "../../../lib/quest/index.js";
import { setQuestParent, setQuestStatusByDir } from "../lifecycle.js";
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

	for (const change of plan.changes) {
		const entry = index.quests.get(change.id);
		if (!entry) continue;
		const result = setQuestParent(entry.dir, change.newParent);
		if (!result.ok) return refuse(result.guidance);
	}
	recordStructuralOp(
		state.questsRoot,
		"reparent",
		plan.changes.map((c) => ({
			id: c.id,
			field: "parent" as const,
			old: c.oldParent,
			new: c.newParent,
		})),
	);
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
	for (const change of plan.changes) {
		const entry = index.quests.get(change.id);
		if (!entry) continue;
		const result = setQuestStatusByDir(
			entry.dir,
			newStatus as QuestFrontMatter["status"],
		);
		if (!result.ok) return refuse(result.guidance);
		appendJourneyByPath(entry.dir, journey);
	}
	recordStructuralOp(
		state.questsRoot,
		action,
		plan.changes.map((c) => ({
			id: c.id,
			field: "status" as const,
			old: c.oldStatus,
			new: c.newStatus,
		})),
	);
	return ok(
		`${action === "conclude" ? "Concluded" : "Retired"} ${plan.changes.length} quest(s).`,
		{
			changes: plan.changes,
			dryRun: false,
		},
	);
}

export function undo(state: QuestState): QuestResult {
	const last = lastStructuralOp(state.questsRoot);
	if (!last) {
		return refuse("Nothing to undo; the structural journal is empty.");
	}
	const { index } = discoverQuests(state.questsRoot);
	const skipped: string[] = [];
	for (const change of last.changes) {
		const entry = index.quests.get(change.id);
		if (!entry) {
			skipped.push(change.id);
			continue;
		}
		const result =
			change.field === "parent"
				? setQuestParent(entry.dir, change.old)
				: setQuestStatusByDir(
						entry.dir,
						change.old as QuestFrontMatter["status"],
					);
		if (!result.ok) return refuse(result.guidance);
	}
	dropLastStructuralOp(state.questsRoot);
	const note =
		skipped.length > 0
			? ` (skipped ${skipped.length} missing quest(s): ${skipped.join(", ")})`
			: "";
	return ok(`Undid ${last.op} of ${last.changes.length} quest(s)${note}.`, {
		op: last.op,
		changes: last.changes,
		skipped,
	});
}
