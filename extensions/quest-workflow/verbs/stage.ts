/**
 * Stage-machine verbs: think, draft, build, conclude,
 * retire. Plus the primary-plan pinning helpers and the
 * quest-scoped concludeOrRetire (which delegates to
 * stageTransition for document-scoped calls).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "@mariozechner/pi-coding-agent";
import { nowYmd } from "../../../lib/internal/quest/dates.js";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../lib/internal/quest/frontmatter.js";
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
	refreshProgress,
	setLoadedStatus,
	stampQuestUpdated,
	writeDocumentStage,
} from "../lifecycle.js";
import { type TransitionAction, transition } from "../machine.js";
import type { QuestState } from "../state.js";
import {
	DOCUMENT_KINDS_SET,
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.js";

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
 * Returns whether the focused document is the quest's
 * primary plan. Fail-closed: when we cannot determine the
 * primary plan (corrupt README, IO failure), the gate
 * fires so the agent stops and surfaces the problem
 * rather than sliding past it.
 */
function isPrimaryPlan(state: QuestState): { primary: boolean; ok: boolean } {
	if (!state.questDir || !state.documentId) {
		return { primary: false, ok: true };
	}
	const path = join(state.questDir, "README.md");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { primary: true, ok: false };
	}
	const parsed = parseQuestFrontMatter(text);
	if (!parsed) return { primary: true, ok: false };
	const recorded = parsed.frontMatter.primaryPlanId;
	if (recorded) {
		return { primary: recorded === state.documentId, ok: true };
	}
	// No primaryPlanId recorded yet (legacy quest or the
	// draft pin failed): treat the current plan as primary
	// so the gate still fires for the user's first build.
	return { primary: true, ok: true };
}

/**
 * Drive the document stage machine: think -> draft ->
 * build -> conclude/retire. Handles the build-stage tree
 * gate and the first-draft document scaffolding inline.
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
			`Thinking about a ${kind} for ${state.questId}: ${params.note.trim()}`,
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

	if (
		action === "build" &&
		state.documentKind === "plan" &&
		params.skipTree !== true
	) {
		const primary = isPrimaryPlan(state);
		if (!primary.ok) {
			return refuse(
				"Build gate cannot determine the quest's primary plan (README unreadable or invalid frontmatter). Fix the README, or pass `skipTree: true` after confirming with the user.",
			);
		}
		if (primary.primary) {
			const treeListing = listTreesOnQuest(state.questDir);
			if (treeListing.ok && treeListing.trees.length === 0) {
				return refuse(
					"This plan is crossing into build with no working tree on the quest. Run `tree-add` first, or pass `skipTree: true` for documentation-only work.",
				);
			}
		}
	}

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
	const sessions = readSessionsFromQuest(state);
	for (const tree of listing.trees) {
		const attached = sessions.filter((s) => s.cwd?.startsWith(tree.path));
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
			removeTreeFromQuest(state.questDir, tree.path);
			pruned.push(tree.path);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			blocked.push({ path: tree.path, reason: message });
		}
	}
	return { pruned, blocked };
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
	const result = setLoadedStatus(
		state,
		action === "conclude" ? "concluded" : "retired",
	);
	if (!result.ok) return refuse(result.guidance);
	if (!result.changed) {
		return ok(
			`Quest already ${action === "conclude" ? "concluded" : "retired"}.`,
		);
	}
	appendJourneyEntry(
		state,
		action === "conclude"
			? "Concluded the quest."
			: `Retired the quest: ${params.reason?.trim()}.`,
	);
	const { pruned, blocked } = await pruneAllTreesOnQuest(state);
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
