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
import {
	type AsyncMutex,
	createMutex,
} from "../../lib/internal/process/async-mutex.ts";
import {
	questsWalked,
	readyQuests,
	signingGaveUp,
} from "../../lib/internal/quest/discovery/discovery.ts";
import { sayConcluded } from "../../lib/internal/quest/fields/concluded.ts";
import { setJournalSession } from "../../lib/internal/quest/fields/structural-journal.ts";
import { sayLanded, sayUnlanded } from "../../lib/internal/session/landings.ts";
import type { QuestPriority } from "../../lib/quest/index.ts";
import { isQuestAction, suggestAction } from "./actions.ts";
import { refuseIgnoredDryRun, refuseUndoElsewhere } from "./dry-run.ts";
import type { QuestState } from "./state.ts";
import { aliasAdd, aliasRemove } from "./verbs/alias.ts";
import { budget } from "./verbs/budget.ts";
import { budgetSweep } from "./verbs/budget-sweep.ts";
import { concludeOrRetire } from "./verbs/conclude.ts";
import { config } from "./verbs/config.ts";
import {
	checkedItem,
	journal,
	read,
	retitle,
	section,
	tick,
} from "./verbs/document.ts";
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
import { needAdd, needRemove } from "./verbs/needs.ts";
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
import { reopenQuest } from "./verbs/seal.ts";
import { spawn } from "./verbs/session.ts";
import {
	sessionAttach,
	sessionAudit,
	sessionDetach,
	sessionRename,
} from "./verbs/session-membership.ts";
import {
	currentSessionId,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./verbs/shared.ts";
import { stageTransition } from "./verbs/stage.ts";
import { reparent, undo } from "./verbs/structural.ts";
import {
	treeAdd,
	treeAdopt,
	treeExpand,
	treeList,
	treeRelease,
	withRepoRules,
} from "./verbs/tree-ops.ts";

export type { QuestResult, QuestToolParams };

// Pi runs the tool calls of one assistant message concurrently, and a
// verb reads the quest, awaits something, then writes it back. Two
// prunes of one tree both found it listed and both removed it, and the
// loser recorded a blocked prune against a tree already gone. So every
// verb takes its turn. Marking the tool sequential would do the same
// for quest calls and serialize every other tool in the batch too.
const turns = createMutex();

// Each conversation's calls in the order it issued them: a call readies
// what it reads and takes its turn behind its own earlier calls, so a
// `journal` after a `create` in one message writes into the new quest,
// while a wait on the tree holds no other conversation's calls.
const issued = new WeakMap<QuestState, AsyncMutex>();

/** The order `state`'s conversation issued its calls in. */
function issueOrder(state: QuestState): AsyncMutex {
	const known = issued.get(state);
	if (known) return known;
	const made = createMutex();
	issued.set(state, made);
	return made;
}

/**
 * Dispatch the action to its handler, one call at a time. A call
 * stopped while it waits for the tree or its turn rejects with an
 * `AbortError` and never runs.
 */
export async function handle(
	state: QuestState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: QuestToolParams,
	signal?: AbortSignal,
): Promise<QuestResult> {
	// Readied before the shared turn, so one conversation's wait on the
	// tree holds no other's quest calls: a signing that ends is the tree
	// as it stands, and this process's own writes after it are read with
	// it. Readied after this conversation's earlier calls have run, so it
	// reads what they wrote and names the quest they left loaded.
	return issueOrder(state).runExclusive(
		async () => {
			const unready = await ready(state, params, signal);
			if (unready) return refuse(unready);
			return turns.runExclusive(
				async () => {
					const actedOn = targetsOf(state, params);
					const result = await dispatch(state, pi, ctx, params, signal);
					tellConcluded(pi, params, actedOn, result);
					tellLanded(pi, params, result);
					return result;
				},
				{ signal },
			);
		},
		{ signal },
	);
}

/**
 * On a host, what an action reads decides what it writes, so it reads
 * the quests it names as they stand, not as a walk a few seconds old
 * found them, and waits on the whole tree signed afresh when what it
 * writes rests on others too. An action that writes nothing answers
 * the last walk when the disk gives no answer in time; one that writes
 * is refused, and this says why.
 */
async function ready(
	state: QuestState,
	params: QuestToolParams,
	signal?: AbortSignal,
): Promise<string | undefined> {
	// An action no verb takes is answered with what it might have meant.
	if (!isQuestAction(params.action)) return undefined;
	const named = [
		...targetsOf(state, params),
		state.questId,
		...idsNamed(params.parent),
		...idsNamed(params.target),
	];
	try {
		await readyQuests(state.questsRoot, named, readsAcross(params), signal);
	} catch (error) {
		if (!signingGaveUp(error)) throw error;
		// Never signed whole on the thread, which would hold every
		// conversation on the disk that just gave no answer.
		if (!questsWalked(state.questsRoot)) return `Nothing read: ${NEVER_READ}`;
		if (writesNothing(params)) return undefined;
		return `Nothing changed: ${QUESTS_UNREAD} Try again in a moment; a listing still answers from the last read.`;
	}
	return undefined;
}

/** Why an action that writes can't go ahead while the disk is slow. */
const QUESTS_UNREAD =
	"the quest folders didn't answer a read in time, and what this writes rests on them.";

/** Why nothing can answer while the disk has never given a walk. */
const NEVER_READ =
	"the quest folders haven't answered a first read yet. Try again in a moment.";

/** Whether a call writes nothing: a listing, or a dry run of any action. */
function writesNothing(params: QuestToolParams): boolean {
	return params.dryRun === true || WRITES_NOTHING.has(params.action);
}

/**
 * Whether an action decides what it writes from quests it doesn't name:
 * each action not {@link NAMED_ONLY}, and a `load` naming no quest,
 * which finds one by whose trees hold its folder.
 */
function readsAcross(params: QuestToolParams): boolean {
	if (params.action === "load") return idsNamed(params.id).length === 0;
	return !NAMED_ONLY.has(params.action);
}

/** The actions that write nothing, so a walk the disk can't renew answers them. */
const WRITES_NOTHING: ReadonlySet<string> = new Set([
	"expand",
	"show",
	"status",
	"tree-list",
	"list",
	"tree",
	"find",
	"who",
	"links",
	"locate",
	"ancestors",
	"sessions",
	"recent",
]);

/**
 * The actions that write only the quests and documents they name, or
 * write nothing: each other reads quests it doesn't name to decide what
 * it writes, as a rank among siblings, a parent's cycle check, a
 * quest's children before it is sealed, an alias another quest carries
 * or a checkout another quest adopted. A listing writes nothing, so it
 * answers the last walk, at most a minute old, with the quests it names
 * read again.
 */
const NAMED_ONLY: ReadonlySet<string> = new Set([
	"load",
	"unload",
	"show",
	"status",
	"config",
	"focus",
	"unfocus",
	"journal",
	"tick",
	"untick",
	"section",
	"retitle",
	"need-add",
	"need-remove",
	"budget",
	"think",
	"draft",
	"build",
	"alias-remove",
	"tree-add",
	"tree-list",
	"tree-release",
	"expand",
	"session-attach",
	"session-detach",
	"session-rename",
	"spawn",
	"spawn-tab",
	"spawn-pane",
	"spawn-window",
	"list",
	"tree",
	"find",
	"who",
	"links",
	"locate",
	"ancestors",
	"sessions",
	"recent",
]);

/** What a call acts on: the ids it names, else the focused document or quest. */
function targetsOf(state: QuestState, params: QuestToolParams): string[] {
	const named = idsNamed(params.id);
	if (named.length > 0) return named;
	const here = state.documentId ?? state.questId;
	return here ? [here] : [];
}

/**
 * Say on the bus that something was concluded or retired, so the mesh
 * can tell the session's orchestrator (lib/internal/quest/fields/concluded.ts).
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

/**
 * Say on the bus that a document's item was ticked, so the mesh keeps
 * it in the session's presence as a landing, where an orchestrator reads
 * it (lib/internal/session/landings.ts), and that an untick takes one
 * back, since the item it named is no longer done.
 */
function tellLanded(
	pi: ExtensionAPI,
	params: QuestToolParams,
	result: QuestResult,
): void {
	if (params.action !== "tick" && params.action !== "untick") return;
	const item = checkedItem(result);
	if (!item || !pi.events) return;
	if (item.ticked) sayLanded(pi.events, item);
	else sayUnlanded(pi.events, item.ref);
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
			return config(state, params);
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
		case "need-add":
			return needAdd(state, params);
		case "need-remove":
			return needRemove(state, params);
		case "budget":
			return budget(state, params);
		case "budget-sweep":
			return budgetSweep(state, ctx, params, signal);
		case "orchestrate":
			return orchestrate(state, params, true);
		case "unorchestrate":
			return orchestrate(state, params, false);
		case "think":
		case "draft":
		case "build":
			return stageTransition(state, params.action, params);
		case "conclude":
		case "retire":
			return concludeOrRetire(state, params.action, params, signal);
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
			return priorityJump(state, "driving" as QuestPriority, params);
		case "park":
			return priorityJump(state, "bench" as QuestPriority, params);
		case "defer":
			return priorityJump(state, "someday" as QuestPriority, params);
		case "reclassify":
			return reclassify(state, params);
		case "tree":
			return tree(state, params);
		case "tree-add":
			return withRepoRules(
				await treeAdd(state, { ...params, cwd: params.cwd ?? ctx.cwd }, signal),
				ctx,
			);
		case "tree-adopt":
			return withRepoRules(
				treeAdopt(state, { ...params, cwd: params.cwd ?? ctx.cwd }),
				ctx,
			);
		case "tree-list":
			return treeList(state);
		case "tree-release":
			return treeRelease(state, params, signal, ctx.cwd);
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
			return sessions(state, params);
		case "recent":
			return recent(state);
		case "reopen-sessions":
			if (params.machine !== undefined || params.needs !== undefined) {
				return refuse(
					"reopen-sessions reopens sessions on this machine, where pi saved their history, so it can't take a machine or needs. To start a quest's session on another machine, use spawn with machine or needs.",
				);
			}
			if (params.host !== undefined) {
				return refuse(
					"reopen-sessions reopens sessions in terminals, so it can't take host. To bring a quest's session back in the shared host, use spawn with host.",
				);
			}
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
