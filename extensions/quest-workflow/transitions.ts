/**
 * Per-action handlers for the quest tool.
 *
 * Each handler takes the runtime state, the pi extension
 * API, the tool context and the action's parameters, and
 * returns a structured result. Index.ts only dispatches;
 * each handler is responsible for mutating state, writing
 * disk artifacts and producing a human-facing message.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolContext } from "@mariozechner/pi-coding-agent";
import {
	buildAliasIndex,
	lookupAliasDetail,
} from "../../lib/internal/quest/alias-index.js";
import { nowYmd } from "../../lib/internal/quest/dates.js";
import { discoverQuests } from "../../lib/internal/quest/discovery.js";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../lib/internal/quest/frontmatter.js";
import { atomicWriteFile } from "../../lib/internal/quest/io.js";
import {
	addTreeToQuest,
	listTreesOnQuest,
	removeTreeFromQuest,
	setPendingPrune,
} from "../../lib/internal/quest/trees.js";
import {
	type DocumentFrontMatter,
	type DocumentKind,
	fetchUrlHints,
	mintId,
	type QuestAlias,
	type QuestFrontMatter,
	type QuestKind,
	type QuestPriority,
	type QuestSession,
	scaffoldDocument,
	scaffoldQuestReadme,
} from "../../lib/quest/index.js";
import { parseRef, urlForRef } from "../../lib/refs/index.js";
import {
	resolveDriver,
	type TerminalLayout,
} from "../../lib/terminal/index.js";
import { resolveTreeProvider } from "../../lib/tree/index.js";
import {
	addAliasToLoaded,
	appendJourneyEntry,
	attachSessionToLoaded,
	bumpLoadedPriority,
	createDocument,
	detachSessionFromLoaded,
	ensureQuestsRoot,
	focusDocument,
	listAllQuests,
	loadQuest,
	type RankAction,
	refreshProgress,
	removeAliasFromLoaded,
	renameSessionOnLoaded,
	reorderSiblings,
	setLoadedPriority,
	setLoadedStatus,
	stampQuestUpdated,
	unfocusDocument,
	unloadQuest,
	writeDocumentStage,
} from "./lifecycle.js";
import {
	expandQuest,
	findPeople,
	findQuests,
	linksForLoaded,
	showLoaded,
	treeAll,
} from "./lookup.js";
import { type TransitionAction, transition } from "./machine.js";
import type { QuestState } from "./state.js";

export interface QuestToolParams {
	action: string;
	id?: string;
	url?: string;
	title?: string;
	parent?: string;
	kind?: string;
	note?: string;
	reason?: string;
	priority?: string;
	status?: string;
	target?: string;
	ref?: string;
	query?: string;
	since?: string;
	until?: string;
	field?: string;
	refType?: string;
	pattern?: string;
	role?: string;
	name?: string;
	layout?: string;
	command?: string;
	cwd?: string;
	sessionId?: string;
	scope?: string;
	force?: boolean;
	skipTree?: boolean;
}

export type QuestResult =
	| { ok: true; message: string; details?: Record<string, unknown> }
	| { ok: false; guidance: string };

const QUEST_KINDS_SET = new Set(["quest", "subquest", "sidequest"]);
const DOCUMENT_KINDS_SET = new Set(["plan", "research", "brief", "report"]);

function refuse(guidance: string): QuestResult {
	return { ok: false, guidance };
}

function ok(message: string, details?: Record<string, unknown>): QuestResult {
	return { ok: true, message, details };
}

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
			return show(state);
		case "list":
			return list(state);
		case "focus":
			return focus(state, params);
		case "unfocus":
			return unfocus(state);
		case "think":
		case "draft":
		case "build":
			return stageTransition(
				state,
				params.action as TransitionAction,
				params,
				ctx,
			);
		case "conclude":
		case "retire":
			return concludeOrRetire(
				state,
				params.action as "conclude" | "retire",
				params,
				ctx,
			);
		case "top":
		case "bottom":
		case "bump":
		case "sink":
		case "renumber":
		case "before":
		case "after":
			return reorder(state, params);
		case "alias-add":
			return aliasAdd(state, params);
		case "alias-remove":
			return aliasRemove(state, params);
		case "promote":
			return priorityShift(state, "up");
		case "demote":
			return priorityShift(state, "down");
		case "drive":
			return priorityJump(state, "driving");
		case "park":
			return priorityJump(state, "bench");
		case "defer":
			return priorityJump(state, "someday");
		case "tree":
			return tree(state);
		case "tree-add":
			return treeAdd(state, params);
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
		case "spawn-tab":
		case "spawn-pane":
		case "spawn-window":
			return spawn(state, params);
		case "find":
			return find(state, params);
		case "who":
			return who(state, params);
		case "links":
			return linksAction(state, params);
		default:
			return refuse(
				`Unknown action "${params.action}". Try create, load, unload, show, list, tree, expand, focus, unfocus, think, draft, build, conclude, retire, promote, demote, drive, park, defer, top, bottom, bump, sink, before, after, renumber, alias-add, alias-remove, session-attach, session-detach, session-rename, spawn-tab, spawn-pane, spawn-window, find, who or links.`,
			);
	}
}

async function create(
	state: QuestState,
	pi: ExtensionAPI,
	params: QuestToolParams,
): Promise<QuestResult> {
	const kind = (params.kind ?? "sidequest") as QuestKind;
	if (!QUEST_KINDS_SET.has(kind)) {
		return refuse(
			`Unknown kind "${params.kind}". Use quest, subquest or sidequest.`,
		);
	}

	// URL path: parse the URL into a ref, dedup against
	// existing quests, fetch hints when possible, then fall
	// through to the normal create using the seeded title and
	// first alias.
	let seededAlias: QuestAlias | undefined;
	let seededTitle: string | undefined = params.title?.trim() || undefined;
	let seededExcerpt: string | undefined;
	let seededOriginator: { type: string; value: string } | undefined;
	if (params.url?.trim()) {
		const ref = parseRef(params.url.trim());
		if (!ref) {
			return refuse(
				`URL "${params.url}" did not match any registered ref type. Pass a title and create without --url, or register a ref type for this URL shape.`,
			);
		}
		const { index } = discoverQuests(state.questsRoot);
		const aliasIdx = buildAliasIndex(index);
		const lookup = lookupAliasDetail(aliasIdx, ref);
		if (lookup.kind === "collision") {
			return refuse(
				`Alias ${ref.type}:${ref.value} is already on multiple quests (${lookup.questIds.join(", ")}). Resolve the duplicate before adding it again.`,
			);
		}
		if (lookup.kind === "hit") {
			return refuse(
				`Quest ${lookup.questId} already has alias ${ref.type}:${ref.value}. Load it instead: \`quest load ${lookup.questId}\`.`,
			);
		}
		seededAlias = { type: ref.type, value: ref.value };
		const hints = await fetchUrlHints(ref);
		if (hints) {
			if (!seededTitle && hints.title) seededTitle = hints.title;
			seededExcerpt = hints.excerpt;
			seededOriginator = hints.originator;
		}
	}

	if (!seededTitle) {
		return refuse(
			"Give a title in the `title` param (the quest's H1 heading). When passing `url`, the fetcher provides one when it can; otherwise the title is yours to choose.",
		);
	}
	ensureQuestsRoot(state);
	const id = mintId("QEST");

	const frontMatter: QuestFrontMatter = {
		id,
		kind,
		parent: params.parent ?? null,
		status: "active",
		priority: (params.priority as QuestPriority) ?? "active",
		rank: 1,
		started: nowYmd(),
		updated: nowYmd(),
		aliases: seededAlias ? [seededAlias] : [],
		sessions: [],
	};
	const summaryParts: string[] = [];
	if (params.note?.trim()) summaryParts.push(params.note.trim());
	if (seededExcerpt) summaryParts.push(`Source excerpt: ${seededExcerpt}`);
	const summary =
		summaryParts.length > 0 ? summaryParts.join("\n\n") : undefined;

	const castEntries = seededOriginator
		? [
				{
					role: "originator",
					subject: `@${seededOriginator.value}`,
					prose: "",
				},
			]
		: undefined;
	const body = scaffoldQuestReadme({
		frontMatter,
		title: seededTitle,
		summary,
		cast: castEntries,
	});
	const dir = join(state.questsRoot, id);
	const path = join(dir, "README.md");
	if (existsSync(path)) {
		return refuse(
			`Quest directory ${dir} already exists. Mint a new ID and retry.`,
		);
	}
	mkdirSync(dir, { recursive: true });
	// Brand-new quest: no concurrent writers yet, but use the
	// atomic-rename helper for consistency. Once the file is
	// on disk, every subsequent write goes through the lock.
	atomicWriteFile(path, body);
	const result = loadQuest(state, pi, id);
	if (!result.ok) return refuse(result.guidance);

	// Seed first Journey entry pointing at the source URL.
	if (seededAlias) {
		const url = urlForRef(seededAlias) ?? params.url?.trim() ?? "";
		appendJourneyEntry(
			state,
			seededOriginator
				? `Created from ${url} by @${seededOriginator.value}.`
				: `Created from ${url}.`,
		);
	}

	return ok(`Created ${kind} ${id} at ${path}`, { id, path, kind });
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function isUnder(child: string, parent: string): boolean {
	if (child === parent) return true;
	return child.startsWith(`${parent}/`);
}

function questIdFromCwd(state: QuestState, cwd: string): string | undefined {
	const { index } = discoverQuests(state.questsRoot);
	const realCwd = canonical(cwd);
	for (const entry of index.quests.values()) {
		if (isUnder(realCwd, canonical(entry.dir))) {
			return entry.doc.frontMatter.id;
		}
	}
	let bestId: string | undefined;
	let bestLen = -1;
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		const paths: string[] = [];
		for (const a of fm.aliases) {
			if (a.type === "git-worktree") paths.push(a.value);
		}
		for (const tree of fm.trees ?? []) paths.push(tree.path);
		for (const p of paths) {
			const real = canonical(p);
			if (isUnder(realCwd, real) && real.length > bestLen) {
				bestLen = real.length;
				bestId = fm.id;
			}
		}
	}
	return bestId;
}

async function load(
	state: QuestState,
	pi: ExtensionAPI,
	ctx: ToolContext,
	params: QuestToolParams,
): Promise<QuestResult> {
	let targetId = params.id;
	if (!targetId) {
		const cwd = params.cwd ?? ctx.cwd ?? process.cwd();
		if (cwd) targetId = questIdFromCwd(state, cwd);
		if (!targetId) {
			return refuse(
				"Pass the quest's id (e.g. `id: QEST-20260603-AAA111`) or run from inside a tree registered on a quest.",
			);
		}
	}
	const result = loadQuest(state, pi, targetId);
	if (!result.ok) return refuse(result.guidance);

	const loaded = await showLoaded(state);
	const priorSessions = loaded?.frontMatter.sessions ?? [];
	const sid = currentSessionId(ctx, undefined);

	// Propose attaching the current pi session when it's not
	// already attached. The agent decides whether to follow up.
	let proposeAttach: { sessionId: string; cwd?: string } | undefined;
	if (sid && !priorSessions.some((s) => s.id === sid)) {
		proposeAttach = { sessionId: sid };
		if (ctx.cwd) proposeAttach.cwd = ctx.cwd;
	}

	// Build a resume list of prior sessions other than the
	// current one. The agent decides whether to surface them.
	const resumable = priorSessions
		.filter((s) => s.id !== sid)
		.map((s) => ({
			id: s.id,
			name: s.name,
			cwd: s.cwd,
			started: s.started,
			status: s.status,
		}));

	let message = `Loaded ${state.questId}: ${state.questTitle ?? ""}`;
	if (resumable.length > 0) {
		message += `. ${resumable.length} prior session(s) on file; resume one with \`/quest-resume <id>\``;
	}
	if (proposeAttach) {
		message += `. Attach this pi session with \`quest session-attach\` if you want it tracked.`;
	}

	return ok(message, {
		id: state.questId,
		dir: state.questDir,
		proposeAttach,
		resumable,
	});
}

function unload(state: QuestState): QuestResult {
	if (!state.questId) return refuse("No quest loaded.");
	const prior = state.questId;
	unloadQuest(state);
	return ok(`Unloaded ${prior}.`);
}

async function show(state: QuestState): Promise<QuestResult> {
	if (!state.questDir) return refuse("No quest loaded.");
	const projection = await showLoaded(state);
	if (!projection) return refuse("Could not project the loaded quest.");
	return ok(
		`Quest ${projection.frontMatter.id}: ${projection.title ?? "(untitled)"}`,
		{ projection },
	);
}

function list(state: QuestState): QuestResult {
	const entries = listAllQuests(state).map((e) => ({
		id: e.doc.frontMatter.id,
		title: e.doc.title,
		kind: e.doc.frontMatter.kind,
		status: e.doc.frontMatter.status,
		priority: e.doc.frontMatter.priority,
		rank: e.doc.frontMatter.rank,
	}));
	return ok(`${entries.length} quest(s).`, { entries });
}

function focus(state: QuestState, params: QuestToolParams): QuestResult {
	if (!state.questDir)
		return refuse("Load a quest before focusing a document.");
	if (!params.id) {
		return refuse("Pass the document id (e.g. PLAN-20260603-...).");
	}
	const subdir = subdirForDocumentId(params.id);
	if (!subdir) {
		return refuse(`"${params.id}" does not look like a document id.`);
	}
	const path = join(state.questDir, subdir, `${params.id}.md`);
	if (!existsSync(path)) {
		return refuse(`Document ${path} does not exist.`);
	}
	const result = focusDocument(state, path);
	if (!result.ok) return refuse(result.guidance);
	return ok(`Focused ${state.documentId} (${state.documentKind}).`, {
		path,
	});
}

function unfocus(state: QuestState): QuestResult {
	if (!state.documentId) return refuse("No document focused.");
	const prior = state.documentId;
	unfocusDocument(state);
	return ok(`Unfocused ${prior}.`);
}

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

function stageTransition(
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

	// `think` may open a fresh document with a kind. We need
	// both a quest and a kind to create the document on disk.
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
		// Open the loop. We do not write the document yet
		// — that happens at draft, when we know the title.
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

	// Build-stage tree gate. When a primary plan crosses
	// from draft to build and the quest has no trees yet,
	// refuse with a pointer at tree-add. The agent escapes
	// via `note:"no-tree"` for documentation-only builds.
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

	// At draft, mint the document and scaffold it on disk if
	// this is the first time we're entering draft for this
	// loop.
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
			// Pin the first plan drafted on this quest as the
			// primary plan so the build-stage gate has a stable
			// answer independent of filesystem ordering. Later
			// plans get evaluated against this record.
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

	// For other transitions, write the new stage back to the
	// focused document if there is one. Write FIRST, then
	// flip the in-memory stage, so a failed write does not
	// diverge memory from disk.
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

function reorder(state: QuestState, params: QuestToolParams): QuestResult {
	const questId = params.id ?? state.questId;
	if (!questId) {
		return refuse("Load a quest first or pass the quest id in `id`.");
	}
	let action: RankAction;
	switch (params.action) {
		case "top":
			action = { kind: "top" };
			break;
		case "bottom":
			action = { kind: "bottom" };
			break;
		case "bump":
			action = { kind: "bump" };
			break;
		case "sink":
			action = { kind: "sink" };
			break;
		case "renumber":
			action = { kind: "renumber" };
			break;
		case "before":
		case "after":
			if (!params.target) {
				return refuse(
					`\`${params.action}\` needs a \`target\` quest id to position against.`,
				);
			}
			action = { kind: params.action, target: params.target };
			break;
		default:
			return refuse(`Unknown reorder action ${params.action}.`);
	}
	const result = reorderSiblings(state, questId, action);
	if (!result.ok) return refuse(result.guidance);
	return ok(
		`Reordered ${result.result.changes.length} quest(s) in the sibling set.`,
		{ changes: result.result.changes },
	);
}

function parseAliasInput(raw: string): QuestAlias | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	// Prefer the literal `type:value` form when the prefix
	// looks like a registered ref type. This lets the user
	// disambiguate `github-pr:shop/world#47281` from the bare
	// form which would otherwise be read as `github-issue`.
	const literal = /^([a-z][a-z0-9-]*):(.+)$/i.exec(trimmed);
	if (literal) {
		const type = literal[1].trim();
		const value = literal[2].trim();
		if (type && value && !/^https?$/i.test(type)) {
			return { type, value };
		}
	}
	// Otherwise fall through to URL detection through the
	// registered ref types.
	const ref = parseRef(trimmed);
	if (ref) return { type: ref.type, value: ref.value };
	return undefined;
}

function aliasAdd(state: QuestState, params: QuestToolParams): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	const input = params.ref ?? params.url ?? "";
	const alias = parseAliasInput(input);
	if (!alias) {
		return refuse(
			"Pass the alias in `ref` (e.g. `github-pr:shop/world#47281`) or in `url` (a recognised URL).",
		);
	}
	const result = addAliasToLoaded(state, alias);
	if (!result.ok) return refuse(result.guidance);
	if (!result.added) {
		return ok(`Alias ${alias.type}:${alias.value} was already present.`, {
			alias,
			added: false,
		});
	}
	appendJourneyEntry(state, `Linked ${alias.type}:${alias.value}.`);
	return ok(`Added alias ${alias.type}:${alias.value}.`, {
		alias,
		added: true,
	});
}

function aliasRemove(state: QuestState, params: QuestToolParams): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	const input = params.ref ?? params.url ?? "";
	const alias = parseAliasInput(input);
	if (!alias) {
		return refuse(
			"Pass the alias in `ref` (e.g. `github-pr:shop/world#47281`) or in `url`.",
		);
	}
	const result = removeAliasFromLoaded(state, alias);
	if (!result.ok) return refuse(result.guidance);
	if (!result.removed) {
		return refuse(`Alias ${alias.type}:${alias.value} is not on this quest.`);
	}
	return ok(`Removed alias ${alias.type}:${alias.value}.`, { alias });
}

function currentSessionId(
	ctx: ToolContext,
	fallback: string | undefined,
): string | undefined {
	if (fallback) return fallback;
	try {
		// `sessionManager` is a ReadonlySessionManager exposing
		// `getSessionId()`. We avoid hard-importing the type to
		// keep this module light; the harness guarantees the
		// shape.
		const sm = (
			ctx as unknown as {
				sessionManager?: { getSessionId?(): string };
			}
		).sessionManager;
		return sm?.getSessionId?.();
	} catch {
		return undefined;
	}
}

function sessionAttach(
	state: QuestState,
	ctx: ToolContext,
	params: QuestToolParams,
): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	const id = currentSessionId(ctx, params.sessionId);
	if (!id) {
		return refuse(
			"Could not determine current pi session id. Pass it explicitly in `sessionId`.",
		);
	}
	const session: QuestSession = {
		id,
		started: new Date().toISOString(),
		status: "active",
	};
	if (params.name?.trim()) session.name = params.name.trim();
	if (params.cwd?.trim()) session.cwd = params.cwd.trim();
	else if (ctx.cwd) session.cwd = ctx.cwd;
	const result = attachSessionToLoaded(state, session);
	if (!result.ok) return refuse(result.guidance);
	return ok(
		result.added
			? `Attached session ${id} to ${state.questId}.`
			: `Session ${id} was already attached; refreshed status.`,
		{ session, added: result.added },
	);
}

function sessionDetach(
	state: QuestState,
	ctx: ToolContext,
	params: QuestToolParams,
): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	const id = currentSessionId(ctx, params.sessionId);
	if (!id) {
		return refuse(
			"Could not determine session id to detach. Pass it explicitly in `sessionId`.",
		);
	}
	const result = detachSessionFromLoaded(state, id);
	if (!result.ok) return refuse(result.guidance);
	if (!result.detached) {
		return refuse(
			`Session ${id} is not attached (or already detached) on this quest.`,
		);
	}
	return ok(`Detached session ${id}.`, { sessionId: id });
}

function sessionRename(
	state: QuestState,
	ctx: ToolContext,
	params: QuestToolParams,
): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	if (!params.name?.trim())
		return refuse("Pass the new session name in `name`.");
	const id = currentSessionId(ctx, params.sessionId);
	if (!id) return refuse("Pass a session id in `sessionId`.");
	const result = renameSessionOnLoaded(state, id, params.name.trim());
	if (!result.ok) return refuse(result.guidance);
	if (!result.renamed) {
		return refuse(
			`Session ${id} is not attached to this quest or already has that name.`,
		);
	}
	return ok(`Renamed session ${id} to "${params.name.trim()}".`, {
		sessionId: id,
		name: params.name.trim(),
	});
}

async function spawn(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	const layout = (params.layout ??
		params.action.replace(/^spawn-/, "")) as TerminalLayout;
	if (!(["tab", "pane", "window"] as TerminalLayout[]).includes(layout)) {
		return refuse(
			`Unknown layout "${layout}". Use spawn-tab, spawn-pane or spawn-window.`,
		);
	}
	const driver = await resolveDriver();
	if (!driver) {
		return refuse(
			"No terminal driver is available. Register one with `registerTerminalDriver` or seed the built-ins.",
		);
	}
	const cwd = params.cwd?.trim() || state.questDir || undefined;
	const command = params.command?.trim() || "pi";
	const title =
		params.title?.trim() ||
		(state.questId
			? `${state.questId} ${state.questTitle ?? ""}`.trim()
			: undefined);
	try {
		await driver.spawn({ layout, command, cwd, title });
	} catch (err) {
		return refuse(`Spawn failed via ${driver.id}: ${(err as Error).message}`);
	}
	return ok(`Spawned a ${layout} via ${driver.id}.`, {
		driver: driver.id,
		layout,
		cwd,
		command,
	});
}

function find(state: QuestState, params: QuestToolParams): QuestResult {
	const field = params.field as
		| "started"
		| "updated"
		| "due"
		| "eta"
		| undefined;
	if (params.field && !field) {
		return refuse(
			`Unknown field "${params.field}". Use started, updated, due or eta.`,
		);
	}
	const hits = findQuests(state, {
		query: params.query,
		since: params.since,
		until: params.until,
		field,
		priority: params.priority,
		kind: params.kind,
		status: params.status,
		parent: params.parent,
		refType: params.refType,
	});
	return ok(`${hits.length} match(es).`, { hits });
}

function who(state: QuestState, params: QuestToolParams): QuestResult {
	if (!params.name && !params.role) {
		return refuse("Pass `name` and/or `role` to filter Cast bullets.");
	}
	const hits = findPeople(state, { name: params.name, role: params.role });
	return ok(`${hits.length} hit(s).`, { hits });
}

function linksAction(state: QuestState, params: QuestToolParams): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	const links = linksForLoaded(state, {
		kind: params.kind,
		pattern: params.pattern,
		priority: params.priority,
		status: params.status,
	});
	if (!links) return refuse("Could not project links for this quest.");
	const outgoingCount =
		links.outgoing.quests.length +
		links.outgoing.refs.length +
		links.outgoing.urls.length;
	return ok(`${outgoingCount} outgoing, ${links.incoming.length} incoming.`, {
		links,
	});
}

function tree(state: QuestState): QuestResult {
	const nodes = treeAll(state);
	return ok(`Tree with ${nodes.length} top-level quest(s).`, { tree: nodes });
}

function defaultRepoRoot(_state: QuestState, params: QuestToolParams): string {
	if (params.cwd) return params.cwd;
	return process.cwd();
}

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

async function treeAdd(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	if (!state.questDir || !state.questId) {
		return refuse("Load a quest first.");
	}
	const repoRoot = defaultRepoRoot(state, params);
	const provider = resolveTreeProvider(repoRoot);
	if (!provider) {
		return refuse(
			`No tree provider applies to ${repoRoot}. Register one (the harness ships git-worktree as a default).`,
		);
	}
	const name =
		params.name?.trim() || params.title?.trim() || state.questId.toLowerCase();
	try {
		const handle = await provider.create({
			name,
			repoRoot,
			baseBranch: params.ref,
		});
		const tree = {
			path: handle.path,
			branch: handle.branch,
			repoRoot: handle.repoRoot,
			providerId: handle.providerId,
		};
		const result = addTreeToQuest(state.questDir, tree);
		if (!result.ok) return refuse(result.reason);
		appendJourneyEntry(
			state,
			`Added ${handle.providerId} tree at ${handle.path}.`,
		);
		return ok(`Tree ready at ${handle.path}.`, { tree });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return refuse(`Tree create failed: ${message}`);
	}
}

function treeList(state: QuestState): QuestResult {
	if (!state.questDir) return refuse("Load a quest first.");
	const result = listTreesOnQuest(state.questDir);
	if (!result.ok) return refuse(result.reason);
	return ok(`${result.trees.length} tree(s) on the loaded quest.`, {
		trees: result.trees,
	});
}

async function treePrune(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	if (!state.questDir || !state.questId) {
		return refuse("Load a quest first.");
	}
	const listing = listTreesOnQuest(state.questDir);
	if (!listing.ok) return refuse(listing.reason);
	if (listing.trees.length === 0) {
		return refuse("No trees on the loaded quest to prune.");
	}
	const target =
		listing.trees.find(
			(t) => t.path === params.target || t.path === params.ref,
		) ?? listing.trees[0];
	// Refuse outright when an attached session has its cwd
	// somewhere under the tree. Pruning would yank the
	// rug from a live session.
	// `force` is a typed boolean parameter. The agent flips
	// it only after confirming destructive intent with the
	// user. We deliberately do NOT key off a `note` string
	// because notes are free-form prose the agent generates,
	// not consent. `force: true` is the consent signal.
	const force = params.force === true;
	const sessions = readSessionsFromQuest(state);
	const attached = sessions.filter((s) => s.cwd?.startsWith(target.path));
	if (attached.length > 0 && !force) {
		const names = attached.map((s) => s.name ?? s.id).join(", ");
		return refuse(
			`Tree at ${target.path} has attached session(s) (${names}). Detach them with \`session-detach\` before pruning, or pass force:true after confirming with the user.`,
		);
	}
	const provider =
		resolveTreeProvider(target.repoRoot ?? target.path) ??
		resolveTreeProvider(process.cwd());
	if (!provider) {
		return refuse(
			`No tree provider applies to ${target.repoRoot ?? target.path}.`,
		);
	}
	try {
		await provider.prune({ path: target.path, force });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const detectedAt = new Date().toISOString();
		setPendingPrune(state.questDir, {
			path: target.path,
			reason: message,
			detectedAt,
		});
		return refuse(
			`Tree prune blocked: ${message} Resolve the conflict and retry, or pass force:true after confirming with the user.`,
		);
	}
	const removal = removeTreeFromQuest(state.questDir, target.path);
	if (!removal.ok) return refuse(removal.reason);
	setPendingPrune(state.questDir, null, { clearPath: target.path });
	appendJourneyEntry(state, `Pruned tree at ${target.path}.`);
	return ok(`Tree at ${target.path} pruned.`, { path: target.path });
}

async function treeExpand(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	if (!state.questDir) return refuse("Load a quest first.");
	const zone = params.ref?.trim();
	if (!zone) {
		return refuse("Pass the zone to add in `ref` (e.g. system/gitstream).");
	}
	const listing = listTreesOnQuest(state.questDir);
	if (!listing.ok) return refuse(listing.reason);
	if (listing.trees.length === 0) {
		return refuse("No trees on the loaded quest. Run tree-add first.");
	}
	const target = listing.trees[0];
	const provider = resolveTreeProvider(target.repoRoot ?? target.path);
	if (!provider) {
		return refuse("No tree provider applies to the loaded quest's tree.");
	}
	const expander = (
		provider as unknown as {
			expand?: (input: { path: string; zone: string }) => Promise<void>;
		}
	).expand;
	if (typeof expander !== "function") {
		return refuse(
			`Provider ${provider.id} does not support expand. (zone-aware providers, like dev-tree in joel.gerber.pi, implement this.)`,
		);
	}
	try {
		await expander({ path: target.path, zone });
		appendJourneyEntry(state, `Expanded ${target.path} with zone ${zone}.`);
		return ok(`Zone ${zone} added to ${target.path}.`, { zone });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return refuse(`Tree expand failed: ${message}`);
	}
}

function expand(state: QuestState, params: QuestToolParams): QuestResult {
	const id = params.id ?? state.questId;
	if (!id) {
		return refuse("Pass a quest id in `id` or load one first.");
	}
	const node = expandQuest(state, id);
	if (!node) return refuse(`No quest with id "${id}".`);
	return ok(`Expanded ${id} with ${node.children.length} child quest(s).`, {
		node,
	});
}

function priorityShift(
	state: QuestState,
	direction: "up" | "down",
): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	const result = bumpLoadedPriority(state, direction);
	if (!result.ok) return refuse(result.guidance);
	if (result.from === result.to) {
		return ok(
			direction === "up"
				? `Already at the top of the priority ladder (${result.from}).`
				: `Already at the bottom of the priority ladder (${result.from}).`,
			{ from: result.from, to: result.to },
		);
	}
	appendJourneyEntry(state, `Moved from ${result.from} to ${result.to}.`);
	return ok(`Now ${result.to} (was ${result.from}).`, {
		from: result.from,
		to: result.to,
	});
}

function priorityJump(state: QuestState, to: QuestPriority): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	const from = state.questPriority ?? "active";
	const result = setLoadedPriority(state, to);
	if (!result.ok) return refuse(result.guidance);
	if (!result.changed) {
		return ok(`Already ${to}.`, { from, to });
	}
	appendJourneyEntry(state, `Moved from ${from} to ${to}.`);
	return ok(`Now ${to} (was ${from}).`, { from, to });
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
	// Snapshot the attached sessions once so the auto-prune
	// loop refuses to delete a tree that still has a live
	// session inside it. retire is allowed to leave blockers
	// behind: the user resolves them after detaching.
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

async function concludeOrRetire(
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
			? `Concluded the quest.`
			: `Retired the quest: ${params.reason?.trim()}.`,
	);
	// Auto-prune the quest's trees. Clean trees go quietly;
	// dirty or unmerged ones surface as blockers the user
	// has to resolve before the quest's pruning is fully
	// closed out.
	const { pruned, blocked } = await pruneAllTreesOnQuest(state);
	for (const path of pruned) {
		appendJourneyEntry(state, `Pruned tree at ${path}.`);
	}
	let message =
		action === "conclude"
			? `Concluded quest ${state.questId}.`
			: `Retired quest ${state.questId}.`;
	if (pruned.length > 0) message += ` Pruned ${pruned.length} tree(s).`;
	if (blocked.length > 0) {
		const detectedAt = new Date().toISOString();
		for (const b of blocked) {
			// One setPendingPrune per blocker: the array-aware
			// store appends/upserts by path so every blocker
			// survives the retire.
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
	});
}

function subdirForDocumentId(id: string): string | undefined {
	const prefix = id.split("-")[0];
	switch (prefix) {
		case "PLAN":
			return "plans";
		case "RSCH":
			return "research";
		case "BRIF":
			return "briefs";
		case "RPRT":
			return "reports";
		default:
			return undefined;
	}
}
