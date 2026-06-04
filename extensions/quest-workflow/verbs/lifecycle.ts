/**
 * Quest-lifecycle verbs: create, load, unload, show,
 * list, focus, unfocus.
 *
 * Plus the cwd-walk helper `questIdFromCwd` that `load`
 * uses when no id is passed.
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolContext } from "@mariozechner/pi-coding-agent";
import {
	buildAliasIndex,
	lookupAliasDetail,
} from "../../../lib/internal/quest/alias-index.js";
import { nowYmd } from "../../../lib/internal/quest/dates.js";
import { discoverQuests } from "../../../lib/internal/quest/discovery.js";
import { atomicWriteFile } from "../../../lib/internal/quest/io.js";
import {
	fetchUrlHints,
	mintId,
	type QuestAlias,
	type QuestFrontMatter,
	type QuestKind,
	type QuestPriority,
	scaffoldQuestReadme,
} from "../../../lib/quest/index.js";
import { parseRef, urlForRef } from "../../../lib/refs/index.js";
import {
	appendJourneyEntry,
	ensureQuestsRoot,
	focusDocument,
	listAllQuests,
	loadQuest,
	unfocusDocument,
	unloadQuest,
} from "../lifecycle.js";
import { buildRowExpansion, showLoaded } from "../lookup.js";

/**
 * Priority ladder for sorting list output. Lower numbers
 * sort first; driving is the most prominent bucket. A
 * priority outside the ladder sorts to the end so legacy
 * values do not silently jump ahead of legitimate ones.
 */
const PRIORITY_ORDER: Record<string, number> = {
	driving: 0,
	active: 1,
	queued: 2,
	bench: 3,
	someday: 4,
};
const PRIORITY_FALLBACK = 99;

import {
	type ListingDetails,
	type ListingFlatRow,
	paginate,
	type QuestRowBrief,
	renderListing,
	renderRowBrief,
} from "../render-rows.js";
import type { QuestState } from "../state.js";
import { subdirForDocumentId } from "./queries.js";
import {
	currentSessionId,
	ok,
	QUEST_KINDS_SET,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.js";

/**
 * Look up the quest that owns the given cwd. Walks the
 * quest dirs first (cwd inside quest's own directory),
 * then registered trees (deepest match wins). Every path
 * is canonicalised through realpath so /var vs /private/var
 * and bind-mounts compare correctly.
 */
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

export function questIdFromCwd(
	state: QuestState,
	cwd: string,
): string | undefined {
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

/** Mint a new quest, optionally seeded from a URL. */
export async function create(
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
	atomicWriteFile(path, body);
	const result = loadQuest(state, pi, id);
	if (!result.ok) return refuse(result.guidance);

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

/** Load a quest by id (or via cwd lookup when no id given). */
export async function load(
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

	let proposeAttach: { sessionId: string; cwd?: string } | undefined;
	if (sid && !priorSessions.some((s) => s.id === sid)) {
		proposeAttach = { sessionId: sid };
		if (ctx.cwd) proposeAttach.cwd = ctx.cwd;
	}

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

export function unload(state: QuestState): QuestResult {
	if (!state.questId) return refuse("No quest loaded.");
	const prior = state.questId;
	unloadQuest(state);
	return ok(`Unloaded ${prior}.`);
}

export async function show(state: QuestState): Promise<QuestResult> {
	if (!state.questDir) return refuse("No quest loaded.");
	const projection = await showLoaded(state);
	if (!projection) return refuse("Could not project the loaded quest.");
	return ok(renderShow(projection), { projection });
}

function renderShow(
	projection: NonNullable<Awaited<ReturnType<typeof showLoaded>>>,
): string {
	const fm = projection.frontMatter;
	const lines: string[] = [];
	lines.push(`${fm.id}: ${projection.title ?? "(untitled)"}`);
	lines.push(
		`  kind: ${fm.kind}  status: ${fm.status}  priority: ${fm.priority}  parent: ${fm.parent ?? "none"}  updated: ${fm.updated}`,
	);
	if (projection.summary) lines.push(`  summary: ${projection.summary}`);
	if (projection.purpose) lines.push(`  purpose: ${projection.purpose}`);
	if (projection.cast.length > 0) {
		lines.push("");
		lines.push("Cast:");
		for (const c of projection.cast) {
			const identity = c.identityId ? ` [${c.identityId}]` : "";
			lines.push(`  - ${c.subject} (${c.role})${identity}`);
		}
	}
	if (projection.documents.length > 0) {
		lines.push("");
		lines.push("Documents:");
		for (const d of projection.documents) {
			const title = d.title ?? "(untitled)";
			lines.push(`  - ${d.id} (${d.kind}, ${d.stage}): ${title}`);
		}
	}
	const outgoing = projection.links;
	const outgoingCount =
		outgoing.quests.length + outgoing.refs.length + outgoing.urls.length;
	if (outgoingCount > 0) {
		lines.push("");
		lines.push(`Links out (${outgoingCount}):`);
		for (const q of outgoing.quests) {
			lines.push(`  -> ${q.id} ${q.title ?? ""}`.trimEnd());
		}
		for (const r of outgoing.refs) {
			lines.push(`  -> ${r.type}:${r.value}${r.url ? ` (${r.url})` : ""}`);
		}
		for (const u of outgoing.urls) {
			lines.push(`  -> ${u}`);
		}
	}
	const produced = projection.echoes.filter((e) => e.relation === "produced");
	const referenced = projection.echoes.filter(
		(e) => e.relation === "reference",
	);
	if (produced.length > 0) {
		lines.push("");
		lines.push(`Produced by (${produced.length}):`);
		for (const e of produced) {
			lines.push(`  <- ${e.questId} ${e.questTitle ?? ""}`.trimEnd());
		}
	}
	if (referenced.length > 0) {
		lines.push("");
		lines.push(`Referenced by (${referenced.length}):`);
		for (const e of referenced) {
			lines.push(`  <- ${e.questId} ${e.questTitle ?? ""}`.trimEnd());
		}
	}
	if (projection.journey.length > 0) {
		lines.push("");
		lines.push("Recent journey:");
		for (const j of projection.journey) {
			lines.push(`  ${j.date}: ${j.prose}`);
		}
	}
	return lines.join("\n");
}

export function list(state: QuestState, params: QuestToolParams): QuestResult {
	const all = listAllQuests(state);
	const entries = all.filter((e) => {
		const fm = e.doc.frontMatter;
		if (params.priority && fm.priority !== params.priority) return false;
		if (params.kind && fm.kind !== params.kind) return false;
		if (params.status && fm.status !== params.status) return false;
		if (params.parent !== undefined) {
			const expected = params.parent === "null" ? null : params.parent;
			if (fm.parent !== expected) return false;
		}
		return true;
	});
	entries.sort((a, b) => {
		const pa = PRIORITY_ORDER[a.doc.frontMatter.priority] ?? PRIORITY_FALLBACK;
		const pb = PRIORITY_ORDER[b.doc.frontMatter.priority] ?? PRIORITY_FALLBACK;
		if (pa !== pb) return pa - pb;
		return a.doc.frontMatter.rank - b.doc.frontMatter.rank;
	});
	const view = paginate(entries, {
		limit: params.limit,
		offset: params.offset,
	});
	const rows: ListingFlatRow[] = view.rows.map((entry) => ({
		id: entry.doc.frontMatter.id,
		kind: entry.doc.frontMatter.kind,
		status: entry.doc.frontMatter.status,
		title: entry.doc.title ?? null,
		priority: entry.doc.frontMatter.priority,
		parent: entry.doc.frontMatter.parent,
		updated: entry.doc.frontMatter.updated,
		depth: 0,
		...buildRowExpansion(entry),
	}));
	const rendered = rows.map((row) => {
		const brief: QuestRowBrief = {
			id: row.id,
			kind: row.kind,
			status: row.status,
			title: row.title,
		};
		return renderRowBrief(brief);
	});
	const listing: ListingDetails = {
		rows,
		total: view.total,
		offset: view.offset,
		limit: view.limit,
		remaining: view.remaining,
	};
	return ok(renderListing(rendered, view), {
		listing,
		total: view.total,
		offset: view.offset,
		limit: view.limit,
		remaining: view.remaining,
	});
}

export function focus(state: QuestState, params: QuestToolParams): QuestResult {
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

export function unfocus(state: QuestState): QuestResult {
	if (!state.documentId) return refuse("No document focused.");
	const prior = state.documentId;
	unfocusDocument(state);
	return ok(`Unfocused ${prior}.`);
}
