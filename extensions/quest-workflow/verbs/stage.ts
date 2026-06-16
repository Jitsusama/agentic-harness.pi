/**
 * Stage-machine verbs: think, draft, build, conclude,
 * retire. Plus the primary-plan pinning helpers and the
 * quest-scoped concludeOrRetire (which delegates to
 * stageTransition for document-scoped calls).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "@mariozechner/pi-coding-agent";
import { nowYmd } from "../../../lib/internal/quest/dates.js";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../lib/internal/quest/frontmatter.js";
import { isWithin } from "../../../lib/internal/quest/git-signals.js";
import { atomicWriteFile } from "../../../lib/internal/quest/io.js";
import {
	listTreesOnQuest,
	removeTreeFromQuest,
	setPendingPrune,
} from "../../../lib/internal/quest/trees.js";
import {
	checkboxProgress,
	type DocumentFrontMatter,
	type DocumentKind,
	mintId,
	type QuestFrontMatter,
	type QuestSession,
	scaffoldDocument,
} from "../../../lib/quest/index.js";
import { resolveTreeProvider } from "../../../lib/tree/index.js";
import {
	appendJourneyEntry,
	createDocument,
	focusDocument,
	refreshProgress,
	setLoadedStatus,
	stampQuestUpdated,
	writeDocumentStage,
} from "../lifecycle.js";
import { type TransitionAction, transition } from "../machine.js";
import type { QuestState } from "../state.js";
import { subdirForDocumentId } from "./queries.js";
import {
	DOCUMENT_KINDS_SET,
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.js";
import { bulkConcludeOrRetire } from "./structural.js";

/**
 * Pin `planId` as the quest's primary plan when no primary
 * has been recorded yet. Quietly leaves an existing
 * recorded primary in place. This runs at draft time so
 * the gate has a stable answer the first time the user
 * tries to build.
 */
function pinPrimaryPlanIfUnset(questDir: string, planId: string): void {
	const path = join(questDir, "README.md");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return;
	}
	const parsed = parseQuestFrontMatter(text);
	if (!parsed) return;
	if (parsed.frontMatter.primaryPlanId) return;
	const fm: QuestFrontMatter = {
		...parsed.frontMatter,
		primaryPlanId: planId,
	};
	try {
		atomicWriteFile(path, `${serializeQuestFrontMatter(fm)}\n${parsed.body}`);
	} catch {
		// Best-effort pin: leave the field unset so the next
		// draft tries again. The gate fails closed in the
		// meantime.
	}
}

/**
 * Drive the document stage machine: think -> draft ->
 * build -> conclude/retire. The build-stage code home is
 * enforced at write time by the write classifier (see
 * enforce.ts), not at the transition, so crossing into
 * build never refuses; first-draft document scaffolding is
 * handled inline.
 */
export function stageTransition(
	state: QuestState,
	action: TransitionAction,
	params: QuestToolParams,
	_ctx: ToolContext,
): QuestResult {
	if (!state.questDir) {
		return refuse(
			"Load a quest before driving the document machine. Try `quest load <id>` first.",
		);
	}

	if (action === "think" && state.documentStage === "idle") {
		if (!params.note?.trim()) {
			return refuse(
				"Say what this document is about in `note`: the problem you are investigating, the plan you are about to draft, or the brief you are scoping.",
			);
		}
		const kind = (params.kind ?? "plan") as DocumentKind;
		if (!DOCUMENT_KINDS_SET.has(kind)) {
			return refuse(
				`Unknown kind "${params.kind}". Use plan, research, brief or report.`,
			);
		}
		state.documentKind = kind;
		state.documentStage = "think";
		state.documentId = null;
		state.documentPath = null;
		state.documentTitle = null;
		state.done = 0;
		state.total = 0;
		return ok(
			`Thinking about a ${kind} for ${state.questId}: ${params.note.trim()}. This loop has no document id yet; \`draft\` (with a title) mints it.`,
			{ stage: "think", kind },
		);
	}

	const result = transition(
		{ stage: state.documentStage },
		{
			action,
			note: params.note,
			reason: params.reason,
		},
	);
	if (!result.ok) return refuse(result.guidance);

	if (action === "draft" && !state.documentId) {
		if (!params.title?.trim()) {
			return refuse(
				"Give the document a title in `title` (it becomes the H1).",
			);
		}
		const kind = state.documentKind ?? "plan";
		const prefix = (
			{
				plan: "PLAN",
				research: "RSCH",
				brief: "BRIF",
				report: "RPRT",
			} as const
		)[kind];
		const id = mintId(prefix);
		const fm: DocumentFrontMatter = {
			id,
			kind,
			quest: state.questId ?? "",
			stage: "draft",
			updated: nowYmd(),
		};
		const body = scaffoldDocument({
			frontMatter: fm,
			title: params.title.trim(),
		});
		const path = createDocument(state, {
			id,
			kind,
			title: params.title.trim(),
			stage: "draft",
			scaffoldBody: body,
		});
		if (!path) {
			return refuse("Failed to scaffold document; is a quest loaded?");
		}
		state.documentId = id;
		state.documentPath = path;
		state.documentTitle = params.title.trim();
		state.documentStage = "draft";
		state.documentKind = kind;
		if (kind === "plan" && state.questDir) {
			pinPrimaryPlanIfUnset(state.questDir, id);
		}
		refreshProgress(state);
		appendJourneyEntry(state, `Drafted ${kind} ${id}.`);
		return ok(`Drafted ${kind} ${id} at ${path}.`, {
			stage: "draft",
			id,
			path,
		});
	}

	if (state.documentPath) writeDocumentStage(state, result.state.stage);
	state.documentStage = result.state.stage;
	refreshProgress(state);
	if (action === "build") {
		appendJourneyEntry(
			state,
			`Building against ${state.documentKind} ${state.documentId}.`,
		);
	} else if (action === "conclude") {
		appendJourneyEntry(
			state,
			`Concluded ${state.documentKind} ${state.documentId}.`,
		);
	} else if (action === "retire") {
		appendJourneyEntry(
			state,
			`Retired ${state.documentKind} ${state.documentId}: ${params.reason ?? "no reason given"}.`,
		);
	}
	if (state.questDir) stampQuestUpdated(state);
	return ok(
		`Now ${result.state.stage} on ${state.documentKind} ${state.documentId}.`,
		{ stage: result.state.stage },
	);
}

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

async function pruneAllTreesOnQuest(state: QuestState): Promise<{
	pruned: string[];
	blocked: { path: string; reason: string }[];
}> {
	const pruned: string[] = [];
	const blocked: { path: string; reason: string }[] = [];
	if (!state.questDir) return { pruned, blocked };
	const listing = listTreesOnQuest(state.questDir);
	if (!listing.ok) return { pruned, blocked };
	for (const tree of listing.trees) {
		// Only auto-prune trees the tool scaffolded. Adopted trees, and
		// legacy or hand-registered trees with no origin marker, are
		// references the quest does not own, so concluding the quest
		// must never delete them; they are released deliberately with
		// tree-prune.
		if (tree.origin !== "scaffolded") continue;
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
				reason: `attached session(s): ${names}`,
			});
			continue;
		}
		const provider = resolveTreeProvider(tree.repoRoot ?? tree.path);
		if (!provider) {
			blocked.push({ path: tree.path, reason: "no applicable provider" });
			continue;
		}
		try {
			await provider.prune({ path: tree.path });
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

/**
 * Conclude or retire a specific document by id: focus it so the
 * stage machine and widget stay in sync, then drive the document
 * transition. This shares the focused-document semantics, so like
 * any document conclusion it is not reversible through `undo`
 * (only the quest sweep journals a structural op).
 */
function concludeDocumentById(
	state: QuestState,
	action: "conclude" | "retire",
	params: QuestToolParams,
	ctx: ToolContext,
	id: string,
	subdir: string,
): QuestResult {
	if (!state.questDir) {
		return refuse("Load a quest before concluding or retiring a document.");
	}
	const path = join(state.questDir, subdir, `${id}.md`);
	if (!existsSync(path)) {
		return refuse(
			`Document ${id} not found under the loaded quest. Load the quest that owns it, or pass a quest id for a status sweep.`,
		);
	}
	const focused = focusDocument(state, path);
	if (!focused.ok) return refuse(focused.guidance);
	return stageTransition(state, action, params, ctx);
}

/**
 * Quest-or-document scoped conclude/retire. With a focused
 * document and no explicit scope, delegates to
 * stageTransition. Otherwise concludes or retires the
 * whole quest and auto-prunes its trees.
 */
export async function concludeOrRetire(
	state: QuestState,
	action: "conclude" | "retire",
	params: QuestToolParams,
	ctx: ToolContext,
): Promise<QuestResult> {
	// An explicit id (single or a comma list) selects the target set
	// for a reversible status sweep, distinct from concluding the
	// loaded quest. Naming an id always targets that id, so a single
	// id never silently falls through to the loaded quest.
	const targetId = (params.id ?? "").trim();
	if (targetId.length > 0) {
		// A single document-kind id (PLAN/RSCH/BRIF/RPRT) concludes or
		// retires that document under the loaded quest, with the same
		// (non-undoable) semantics as concluding a focused document.
		// Quest ids, and any comma list, run the reversible quest sweep.
		const subdir = targetId.includes(",")
			? undefined
			: subdirForDocumentId(targetId);
		if (subdir) {
			return concludeDocumentById(state, action, params, ctx, targetId, subdir);
		}
		return bulkConcludeOrRetire(state, action, params);
	}
	if (!state.questDir) {
		return refuse("Load a quest before concluding or retiring anything.");
	}
	const scope =
		params.scope === "quest" || params.scope === "document"
			? params.scope
			: state.documentId
				? "document"
				: "quest";
	if (scope === "document") {
		return stageTransition(state, action, params, ctx);
	}
	if (action === "retire" && !params.reason?.trim()) {
		return refuse("Retire needs a `reason`: why is the quest being abandoned?");
	}
	const target = action === "conclude" ? "concluded" : "retired";
	if (state.questStatus === target) {
		return ok(`Quest already ${target}.`);
	}
	// Prune before flipping status so a prune that cannot complete
	// leaves the quest in its prior state with the blocked trees
	// recorded, rather than sealing a still-active quest.
	const { pruned, blocked } = await pruneAllTreesOnQuest(state);
	const result = setLoadedStatus(state, target);
	if (!result.ok) return refuse(result.guidance);
	appendJourneyEntry(
		state,
		action === "conclude"
			? "Concluded the quest."
			: `Retired the quest: ${params.reason?.trim()}.`,
	);
	for (const path of pruned) {
		appendJourneyEntry(state, `Pruned tree at ${path}.`);
	}
	let message =
		action === "conclude"
			? `Concluded quest ${state.questId}.`
			: `Retired quest ${state.questId}.`;
	if (pruned.length > 0) message += ` Pruned ${pruned.length} tree(s).`;
	const drift = action === "conclude" ? primaryPlanDrift(state) : undefined;
	if (drift) {
		const open = drift.total - drift.done;
		message += ` Warning: primary plan ${drift.planId} still has ${open} unchecked item(s) (${drift.done}/${drift.total} done); concluded anyway.`;
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
		message += ` ${blocked.length} tree(s) need manual resolution.`;
	}
	return ok(message, {
		scope: "quest",
		action,
		prunedTrees: pruned,
		blockedTrees: blocked,
		...(drift ? { planDrift: drift } : {}),
	});
}
