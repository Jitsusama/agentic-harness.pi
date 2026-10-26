/**
 * Quest tool dispatcher.
 *
 * Each verb family lives under `./verbs/`: lifecycle
 * (create/load/show/...), stage (think/draft/build/...),
 * reorder (top/bottom/promote/...), alias (alias-add/
 * remove), session (attach/detach/rename), spawn (terminal
 * spawn-*), tree-ops (tree-add/tree-list/...) and queries
 * (find/who/links/tree/expand). This file imports each
 * family and wires its handlers into the action-name
 * switch.
 *
 * Keep it slim: no business logic here. The dispatcher's
 * one job is to route an action name to the right verb
 * module.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createMutex } from "../../lib/internal/async-mutex.ts";
import { sayConcluded } from "../../lib/internal/quest/concluded.ts";
import { setJournalSession } from "../../lib/internal/quest/structural-journal.ts";
import type { QuestPriority } from "../../lib/quest/index.ts";
import { suggestAction } from "./actions.ts";
import { refuseIgnoredDryRun, refuseUndoElsewhere } from "./dry-run.ts";
import type { QuestState } from "./state.ts";
import { aliasAdd, aliasRemove } from "./verbs/alias.ts";
import { configReport } from "./verbs/config.ts";
import { journal, read, retitle, section, tick } from "./verbs/document.ts";
import {
	create,
	focus,
	list,
	load,
	reclassify,
	show,
	unfocus,
	unload,
} from "./verbs/lifecycle.ts";
import { orchestrate } from "./verbs/orchestrate.ts";
import {
	ancestors,
	expand,
	find,
	linksAction,
	locate,
	recent,
	restore,
	sessions,
	subdirForDocumentId,
	tree,
	who,
} from "./verbs/queries.ts";
import { queueOrder } from "./verbs/queue.ts";
import { priorityJump, priorityShift, reorder } from "./verbs/reorder.ts";
import {
	sessionAttach,
	sessionAudit,
	sessionDetach,
	sessionRename,
	spawn,
} from "./verbs/session.ts";
import {
	currentSessionId,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./verbs/shared.ts";
import {
	concludeOrRetire,
	reopenQuest,
	stageTransition,
} from "./verbs/stage.ts";
import { reparent, undo } from "./verbs/structural.ts";
import {
	treeAdd,
	treeAdopt,
	treeExpand,
	treeList,
	treeRelease,
} from "./verbs/tree-ops.ts";

export type { QuestResult, QuestToolParams };

// Pi runs the tool calls of one assistant message concurrently, and a
// verb reads the quest, awaits something, then writes it back. Two
// prunes of one tree both found it listed and both removed it, and the
// loser recorded a blocked prune against a tree already gone. So every
// verb takes its turn. Marking the tool sequential would do the same
// for quest calls and serialize every other tool in the batch too.
const turns = createMutex();

/**
 * Dispatch the action to its handler, one call at a time. A call
 * stopped while it waits for its turn rejects with an `AbortError`
 * and never runs.
 */
export function handle(
	state: QuestState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: QuestToolParams,
	signal?: AbortSignal,
): Promise<QuestResult> {
	return turns.runExclusive(
		async () => {
			const actedOn = targetsOf(state, params);
			const result = await dispatch(state, pi, ctx, params, signal);
			tellConcluded(pi, params, actedOn, result);
			return result;
		},
		{ signal },
	);
}

/** What a call acts on: the ids it names, else the focused document or quest. */
function targetsOf(state: QuestState, params: QuestToolParams): string[] {
	const named = idsNamed(params.id);
	if (named.length > 0) return named;
	const here = state.documentId ?? state.questId;
	return here ? [here] : [];
}

/**
 * Say on the bus that something was concluded or retired, so the mesh
 * can tell the session's orchestrator (lib/internal/quest/concluded.ts).
 * A refusal or a dry run ended nothing, and says nothing.
 */
function tellConcluded(
	pi: ExtensionAPI,
	params: QuestToolParams,
	ids: readonly string[],
	result: QuestResult,
): void {
	if (params.action !== "conclude" && params.action !== "retire") return;
	if (!result.ok || params.dryRun === true || !pi.events) return;
	sayConcluded(pi.events, {
		how: params.action === "conclude" ? "concluded" : "retired",
		ids,
		said: result.message,
	});
}

function idsNamed(id: string | undefined): string[] {
	return (id ?? "")
		.split(",")
		.map((one) => one.trim())
		.filter((one) => one.length > 0);
}

async function dispatch(
	state: QuestState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: QuestToolParams,
	signal?: AbortSignal,
): Promise<QuestResult> {
	// Whatever this call journals is this session's, for its own undo.
	setJournalSession(currentSessionId(ctx, undefined));
	const ignored = refuseIgnoredDryRun(params, state.questsRoot);
	if (ignored) return ignored;
	const elsewhere = refuseUndoElsewhere(params, state.questsRoot);
	if (elsewhere) return elsewhere;
	switch (params.action) {
		case "create":
			return create(state, pi, ctx, params, signal);
		case "load":
			return load(state, pi, ctx, params);
		case "unload":
			return unload(state);
		case "show":
		case "status":
			// A document, a section or an item is read; a quest is projected.
			return params.title?.trim() ||
				params.query?.trim() ||
				(params.id && subdirForDocumentId(params.id))
				? read(state, params)
				: show(state, params);
		case "config":
			return configReport();
		case "list":
			return list(state, params);
		case "focus":
			return focus(state, params);
		case "unfocus":
			return unfocus(state);
		case "journal":
			return journal(state, params);
		case "tick":
			return tick(state, params, true);
		case "untick":
			return tick(state, params, false);
		case "section":
			return section(state, params);
		case "retitle":
			return retitle(state, params);
		case "queue-first":
			return queueOrder(state, params, true);
		case "queue-normal":
			return queueOrder(state, params, false);
		case "orchestrate":
			return orchestrate(state, params, true);
		case "unorchestrate":
			return orchestrate(state, params, false);
		case "think":
		case "draft":
		case "build":
			return stageTransition(state, params.action, params, ctx);
		case "conclude":
		case "retire":
			return concludeOrRetire(state, params.action, params, ctx, signal);
		case "reopen":
			return reopenQuest(state);
		case "top":
		case "bottom":
		case "bump":
		case "sink":
		case "renumber":
		case "before":
		case "after":
			return reorder(state, params);
		case "reparent":
			return reparent(state, params);
		case "undo":
			return undo(state);
		case "alias-add":
			return aliasAdd(state, params);
		case "alias-remove":
			return aliasRemove(state, params);
		case "promote":
			return priorityShift(state, "up", params);
		case "demote":
			return priorityShift(state, "down", params);
		case "drive":
			return priorityJump(state, "driving" as QuestPriority);
		case "park":
			return priorityJump(state, "bench" as QuestPriority);
		case "defer":
			return priorityJump(state, "someday" as QuestPriority);
		case "reclassify":
			return reclassify(state, params);
		case "tree":
			return tree(state, params);
		case "tree-add":
			return treeAdd(state, { ...params, cwd: params.cwd ?? ctx.cwd }, signal);
		case "tree-adopt":
			return treeAdopt(state, { ...params, cwd: params.cwd ?? ctx.cwd });
		case "tree-list":
			return treeList(state);
		case "tree-release":
			return treeRelease(state, params, signal);
		case "tree-expand":
			return treeExpand(state, params);
		case "expand":
			return expand(state, params);
		case "session-attach":
			return sessionAttach(state, ctx, params);
		case "session-detach":
			return sessionDetach(state, ctx, params);
		case "session-rename":
			return sessionRename(state, ctx, params);
		case "session-audit":
			return sessionAudit(state, params);
		case "spawn":
		case "spawn-tab":
		case "spawn-pane":
		case "spawn-window":
			return spawn(state, ctx, params);
		case "find":
			return find(state, params);
		case "who":
			return who(state, params);
		case "links":
			return linksAction(state, params);
		case "locate":
			return locate(state, params);
		case "ancestors":
			return ancestors(state, params);
		case "sessions":
			return sessions(state);
		case "recent":
			return recent(state);
		case "restore":
			// Listing is the default and acting needs force: reopening a
			// dozen tabs is too large a side effect to fire from a verb
			// the user may have run to look. Naming sessions with id picks
			// them out of either list, recently closed ones included.
			return restore(state, {
				act: params.force === true,
				...(params.id !== undefined ? { ids: params.id } : {}),
				...(params.layout !== undefined ? { layout: params.layout } : {}),
				...(params.terminal !== undefined ? { terminal: params.terminal } : {}),
				...(params.nesting !== undefined ? { nesting: params.nesting } : {}),
				...(params.dryRun === true ? { dryRun: true } : {}),
			});
		default: {
			const suggestion = suggestAction(params.action ?? "");
			const hint = suggestion
				? ` Did you mean "${suggestion}"?`
				: " See the schema for the full list of actions.";
			return refuse(`Unknown action "${params.action}".${hint}`);
		}
	}
}
