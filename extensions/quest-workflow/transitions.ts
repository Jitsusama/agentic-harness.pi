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

import type { ExtensionAPI, ToolContext } from "@mariozechner/pi-coding-agent";
import type { QuestPriority } from "../../lib/quest/index.js";
import { suggestAction } from "./actions.js";
import type { QuestState } from "./state.js";
import { aliasAdd, aliasRemove } from "./verbs/alias.js";
import { configReport } from "./verbs/config.js";
import {
	create,
	focus,
	list,
	load,
	reclassify,
	show,
	unfocus,
	unload,
} from "./verbs/lifecycle.js";
import {
	ancestors,
	expand,
	find,
	linksAction,
	locate,
	tree,
	who,
	workspace,
} from "./verbs/queries.js";
import { priorityJump, priorityShift, reorder } from "./verbs/reorder.js";
import {
	sessionAttach,
	sessionAudit,
	sessionDetach,
	sessionRename,
	spawn,
} from "./verbs/session.js";
import {
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./verbs/shared.js";
import {
	concludeOrRetire,
	reopenQuest,
	stageTransition,
} from "./verbs/stage.js";
import { reparent, undo } from "./verbs/structural.js";
import {
	treeAdd,
	treeAdopt,
	treeExpand,
	treeList,
	treePrune,
} from "./verbs/tree-ops.js";

export type { QuestResult, QuestToolParams };

/** Dispatch the action to its handler. */
export async function handle(
	state: QuestState,
	pi: ExtensionAPI,
	ctx: ToolContext,
	params: QuestToolParams,
): Promise<QuestResult> {
	switch (params.action) {
		case "create":
			return create(state, pi, params);
		case "load":
			return load(state, pi, ctx, params);
		case "unload":
			return unload(state);
		case "show":
		case "status":
			return show(state, params);
		case "config":
			return configReport();
		case "list":
			return list(state, params);
		case "focus":
			return focus(state, params);
		case "unfocus":
			return unfocus(state);
		case "think":
		case "draft":
		case "build":
			return stageTransition(state, params.action, params, ctx);
		case "conclude":
		case "retire":
			return concludeOrRetire(state, params.action, params, ctx);
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
			return treeAdd(state, { ...params, cwd: params.cwd ?? ctx.cwd });
		case "tree-adopt":
			return treeAdopt(state, { ...params, cwd: params.cwd ?? ctx.cwd });
		case "tree-list":
			return treeList(state);
		case "tree-prune":
			return treePrune(state, params);
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
		case "workspace":
			return workspace(state);
		default: {
			const suggestion = suggestAction(params.action ?? "");
			const hint = suggestion
				? ` Did you mean "${suggestion}"?`
				: " See the schema for the full list of actions.";
			return refuse(`Unknown action "${params.action}".${hint}`);
		}
	}
}
