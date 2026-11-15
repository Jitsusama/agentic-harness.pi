/**
 * Sealing the loaded quest, once it has been named, and reopening a
 * sealed one: the record held to its audit, its trees pruned, its
 * documents sealed with it, the seal journalled for `undo`, and its
 * scratch removed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	auditQuestRecord,
	isRecordSound,
} from "../../../lib/core/internal/quest/record-audit.ts";
import { resolveTreeProvider } from "../../../lib/core/tree/index.ts";
import { discoverQuests } from "../../../lib/internal/quest/discovery.ts";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/frontmatter.ts";
import { isWithin } from "../../../lib/internal/quest/git-signals.ts";
import { reapQuestScratchDir } from "../../../lib/internal/quest/scratch.ts";
import { isSealedStatus } from "../../../lib/internal/quest/status.ts";
import {
	type JournalChange,
	recordStructuralOp,
} from "../../../lib/internal/quest/structural-journal.ts";
import { treesHere } from "../../../lib/internal/quest/tree-place.ts";
import {
	listTreesOnQuest,
	removeTreeFromQuest,
	setPendingPrune,
} from "../../../lib/internal/quest/trees.ts";
import { clearWaiting, waitingFolder } from "../../../lib/mesh/waiting.ts";
import {
	checkboxProgress,
	type QuestSession,
} from "../../../lib/quest/index.ts";
import { count, noun, verb } from "../../../lib/ui/count.ts";
import { wakeSealedQuestParks } from "../ends-with-quest.ts";
import {
	appendJourneyEntry,
	logHarnessEntry,
	sealQuestDocuments,
	setLoadedStatus,
	setQuestPriorityByDir,
} from "../lifecycle.ts";
import { outsideWritesSaid, readOutsideWrites } from "../outside-writes.ts";
import { recordBreakage } from "../record-watch.ts";
import type { QuestState } from "../state.ts";
import { defaultWorkspaceRoot, workspaceDirOf } from "../workspace.ts";
import { scratchLeftElsewhere, scratchRemoved } from "./scratch-removal.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/**
 * Inspect the loaded quest's primary plan for unchecked work.
 * Returns the plan id and its checkbox tallies when items remain
 * open, so conclude can warn rather than silently sealing a quest
 * with work still on its plan. Returns undefined when there is no
 * primary plan, it is unreadable, has no checkboxes, or is fully
 * checked.
 */
function primaryPlanDrift(
	state: QuestState,
): { planId: string; done: number; total: number } | undefined {
	if (!state.questDir) return undefined;
	let readme: string;
	try {
		readme = readFileSync(join(state.questDir, "README.md"), "utf8");
	} catch {
		return undefined;
	}
	const parsed = parseQuestFrontMatter(readme);
	const planId = parsed?.frontMatter.primaryPlanId;
	if (!planId) return undefined;
	let planText: string;
	try {
		planText = readFileSync(
			join(state.questDir, "plans", `${planId}.md`),
			"utf8",
		);
	} catch {
		return undefined;
	}
	const { done, total } = checkboxProgress(planText);
	if (total === 0 || done >= total) return undefined;
	return { planId, done, total };
}

/** Read the loaded quest's sessions list off disk. */
function readSessionsFromQuest(state: QuestState): QuestSession[] {
	if (!state.questDir) return [];
	try {
		const readme = join(state.questDir, "README.md");
		const text = readFileSync(readme, "utf8");
		const parsed = parseQuestFrontMatter(text);
		return parsed?.frontMatter.sessions ?? [];
	} catch {
		// Quest README missing or unreadable; treat as no
		// sessions so we don't accidentally block pruning.
		return [];
	}
}

async function pruneAllTreesOnQuest(
	state: QuestState,
	signal?: AbortSignal,
): Promise<{
	pruned: string[];
	blocked: { path: string; reason: string }[];
}> {
	const pruned: string[] = [];
	const blocked: { path: string; reason: string }[] = [];
	if (!state.questDir) return { pruned, blocked };
	const listing = listTreesOnQuest(state.questDir);
	if (!listing.ok) return { pruned, blocked };
	// Only this machine's: another machine's trees, seen through a
	// shared quest, stay listed in the sealed README for that machine.
	for (const tree of treesHere(listing.trees)) {
		// Only auto-prune trees the tool scaffolded. Adopted trees, and
		// legacy or hand-registered trees with no origin marker, are
		// references the quest does not own, so concluding the quest
		// must never delete them; they are released deliberately with
		// tree-release.
		if (tree.origin !== "scaffolded") continue;
		// Stopped: the rest are left standing rather than each handed a
		// signal that has already fired.
		if (signal?.aborted) break;
		// Re-read the live session list immediately before each prune
		// rather than from one snapshot taken before the loop: the
		// awaits below yield the event loop, so another session can
		// attach into a tree we are about to prune and must be seen.
		const sessions = readSessionsFromQuest(state);
		const attached = sessions.filter(
			(s) => s.cwd && isWithin(s.cwd, tree.path),
		);
		if (attached.length > 0) {
			const names = attached.map((s) => s.name ?? s.id).join(", ");
			blocked.push({
				path: tree.path,
				reason: `attached ${noun(attached.length, "session")}: ${names}`,
			});
			continue;
		}
		const provider = resolveTreeProvider(tree.repoRoot ?? tree.path);
		if (!provider) {
			blocked.push({ path: tree.path, reason: "no applicable provider" });
			continue;
		}
		try {
			await provider.release({
				path: tree.path,
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			blocked.push({ path: tree.path, reason: message });
			continue;
		}
		// The worktree is gone; de-register it. If the frontmatter write
		// fails the tree is half-pruned (removed on disk, still listed),
		// so surface it for manual cleanup rather than reporting a clean
		// prune.
		const removal = removeTreeFromQuest(state.questDir, tree.path);
		if (!removal.ok) {
			blocked.push({
				path: tree.path,
				reason: `worktree removed but could not be de-registered: ${removal.reason}`,
			});
			continue;
		}
		pruned.push(tree.path);
	}
	return { pruned, blocked };
}

/**
 * Reopen a concluded or retired quest, returning it to active. The
 * inverse of concluding the whole quest; the resuscitate pattern in
 * the quest convention. Document stages are left as they are, so a
 * reopened quest keeps whatever plans it had concluded; the author
 * moves the ones they want back to build deliberately.
 */
export function reopenQuest(state: QuestState): QuestResult {
	if (!state.questId || !state.questDir) {
		return refuse("Load a quest before reopening it.");
	}
	if (state.questStatus !== "concluded" && state.questStatus !== "retired") {
		return refuse(
			`Quest ${state.questId} is ${state.questStatus ?? "active"}, not concluded or retired; there is nothing to reopen.`,
		);
	}
	const result = setLoadedStatus(state, "active");
	if (!result.ok) return refuse(result.guidance);
	appendJourneyEntry(state, "Reopened the quest.");
	return ok(`Reopened quest ${state.questId}; now active.`, {
		status: "active",
	});
}

/** Conclude or retire the loaded quest, once it has been named. */
export async function sealLoadedQuest(
	state: QuestState,
	action: "conclude" | "retire",
	params: QuestToolParams,
	signal?: AbortSignal,
): Promise<QuestResult> {
	if (!state.questDir) {
		return refuse("Load a quest before concluding or retiring anything.");
	}
	if (action === "retire" && !params.reason?.trim()) {
		return refuse("Retire needs a `reason`: why is the quest being abandoned?");
	}
	const target = action === "conclude" ? "concluded" : "retired";
	if (state.questStatus === target) {
		return ok(`Quest already ${target}.`);
	}
	// A concluded quest's record is what the backup keeps and what a
	// later reader trusts, so it must be whole before the quest seals:
	// nothing outside the record, no attachment over the limits, no link
	// into attachments/ that leads nowhere. A retired quest is abandoned
	// as it stands, so it is not held to this.
	const audit =
		action === "conclude" ? auditQuestRecord(state.questDir) : undefined;
	if (audit && !isRecordSound(audit)) {
		const workspace =
			workspaceDirOf(defaultWorkspaceRoot(), state.questId) ?? "";
		const lines = recordBreakage(audit, workspace).map((b) => `- ${b.line}`);
		return refuse(
			`${state.questId}'s record is not whole yet, so it cannot conclude. Put these right first:\n${lines.join("\n")}`,
		);
	}
	// Prune before flipping status so a prune that cannot complete
	// leaves the quest in its prior state with the blocked trees
	// recorded, rather than sealing a still-active quest.
	const { pruned, blocked } = await pruneAllTreesOnQuest(state, signal);
	// Stopped mid-prune is the person taking the seal back, so the quest
	// stays as it was. A tree already removed stays removed, and says so.
	if (signal?.aborted) {
		const gone =
			pruned.length > 0
				? ` ${count(pruned.length, "tree")} already pruned: ${pruned.join(", ")}.`
				: "";
		return refuse(
			`Stopped while pruning trees, so ${state.questId} was not ${action === "conclude" ? "concluded" : "retired"}.${gone}`,
		);
	}
	// Capture the pre-seal status and priority so the seal can be
	// journalled and reversed by undo, the same way the bulk path is.
	const priorStatus = state.questStatus ?? "active";
	const priorPriority = state.questPriority ?? "active";
	const questId = state.questId;
	const result = setLoadedStatus(state, target);
	if (!result.ok) return refuse(result.guidance);
	// Cascade the seal so the quest leaves nothing live behind: drop
	// the priority to the least prominent bucket and seal every
	// still-active document to the same terminal stage. Drop the
	// priority rank-preserving, matching the bulk path: the seal must
	// not renumber the quest's rank, because undo restores only the
	// priority bucket, so a rank moved here would strand the quest at a
	// foreign, colliding rank in its restored bucket.
	if (state.questDir && priorPriority !== "someday") {
		setQuestPriorityByDir(state.questDir, "someday");
		state.questPriority = "someday";
	}
	const sealedDocs = sealQuestDocuments(state.questDir, target);
	// What it had waiting on the person goes with it, so Needs You never
	// shows a sealed quest's item. Undo doesn't bring them back: a quest
	// taken up again raises what still waits.
	if (questId) clearWaiting(waitingFolder(), questId);
	// Journal the seal so undo restores the status and the prior
	// priority bucket, not just the bulk path's version of the same.
	if (questId) {
		const changes: JournalChange[] = [
			{ id: questId, field: "status", old: priorStatus, new: target },
		];
		if (priorPriority !== "someday") {
			changes.push({
				id: questId,
				field: "priority",
				old: priorPriority,
				new: "someday",
			});
		}
		recordStructuralOp(state.questsRoot, action, changes);
	}
	// Reap any scratch dir recorded before workspaces existed; the
	// workspace itself goes at the end, once what it records is read.
	const reapedScratch = reapQuestScratchDir(state.questDir, state.scratchDir);
	state.scratchDir = null;
	appendJourneyEntry(
		state,
		action === "conclude"
			? "Concluded the quest."
			: `Retired the quest: ${params.reason?.trim()}.`,
	);
	for (const path of pruned) {
		logHarnessEntry(state, `Pruned tree at ${path}.`);
	}
	if (reapedScratch) {
		logHarnessEntry(state, "Reaped the managed scratch directory.");
	}
	// What the gates let through outside every tree, said once at the
	// end, so the record shows everything the quest touched.
	const outside = outsideWritesSaid(
		readOutsideWrites(defaultWorkspaceRoot(), state.questId),
	);
	if (outside) appendJourneyEntry(state, outside);
	const named = state.questTitle
		? `${state.questId} (${state.questTitle})`
		: state.questId;
	let message =
		action === "conclude"
			? `Concluded quest ${named}.`
			: `Retired quest ${named}.`;
	if (sealedDocs > 0) {
		appendJourneyEntry(
			state,
			`Sealed ${count(sealedDocs, "document")} with the quest.`,
		);
		message += ` Sealed ${count(sealedDocs, "document")}.`;
	}
	if (pruned.length > 0) message += ` Pruned ${count(pruned.length, "tree")}.`;
	if (audit && audit.uncited.length > 0) {
		message += ` No document cites ${audit.uncited.join(", ")}, so the backup leaves ${audit.uncited.length === 1 ? "it" : "them"} out.`;
	}
	// Warn about live children, matching the bulk path: sealing a loaded
	// parent leaves its live subquests orphaned but live, so surface them
	// rather than cascading or silently stranding them.
	if (questId) {
		const { index } = discoverQuests(state.questsRoot);
		const liveChildren: string[] = [];
		for (const childId of index.children.get(questId) ?? []) {
			const child = index.quests.get(childId);
			if (child && !isSealedStatus(child.doc.frontMatter.status)) {
				liveChildren.push(childId);
			}
		}
		if (liveChildren.length > 0) {
			message += ` Warning: ${count(liveChildren.length, "live child quest")} ${verb(liveChildren.length, "remains", "remain")} under a sealed parent: ${liveChildren.join(", ")}.`;
		}
	}
	const drift = action === "conclude" ? primaryPlanDrift(state) : undefined;
	if (drift) {
		const open = drift.total - drift.done;
		message += ` Warning: primary plan ${drift.planId} still has ${count(open, "unchecked item")} (${drift.done}/${drift.total} done); concluded anyway.`;
	}
	if (blocked.length > 0) {
		const detectedAt = new Date().toISOString();
		for (const b of blocked) {
			setPendingPrune(state.questDir, {
				path: b.path,
				reason: b.reason,
				detectedAt,
			});
		}
		message += ` ${count(blocked.length, "tree")} ${verb(blocked.length, "needs", "need")} manual resolution: ${blocked.map((b) => `${b.path}: ${b.reason}`).join("; ")}. Run \`tree-release\` with its cwd once that is settled.`;
	}
	if (outside) message += ` ${outside}`;
	const removed = await scratchRemoved(
		state.questId,
		signal,
		undefined,
		undefined,
		state.inUse,
	);
	if (removed) {
		logHarnessEntry(state, removed);
		message += ` ${removed}`;
	}
	const elsewhere = state.questId
		? scratchLeftElsewhere(state.questId, readSessionsFromQuest(state))
		: undefined;
	if (elsewhere) {
		logHarnessEntry(state, elsewhere);
		message += ` ${elsewhere}`;
	}
	const woke = questId ? wakeSealedQuestParks(questId) : undefined;
	if (woke) {
		logHarnessEntry(state, woke);
		message += ` ${woke}`;
	}
	return ok(message, {
		scope: "quest",
		action,
		prunedTrees: pruned,
		blockedTrees: blocked,
		...(drift ? { planDrift: drift } : {}),
	});
}
