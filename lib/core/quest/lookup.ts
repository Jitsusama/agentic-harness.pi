/**
 * Read-only projections over the quest tree: find, who, links,
 * tree, expand, ancestors, locate and a lean show. Pure functions
 * over discoverQuests' index, with no I/O beyond the read discovery
 * already does, no host coupling.
 *
 * Deliberately excluded, and left to each adapter: anything keyed
 * to a host's own session log (workspace/recent/restore, an
 * activity-sorted find, per-session liveness in show) and cast
 * identity resolution. Those need a session store or identity
 * registry that not every host has an equivalent for. pi's own
 * `lookup.ts` layers that richness on top of these same
 * projections; a CLI adapter that has no session log just renders
 * what's here.
 */

import {
	discoverQuests,
	type QuestDocumentEntry,
	type QuestEntry,
	type QuestIndex,
} from "../internal/quest/discovery.ts";
import { urlForRef, whyRefHasNoUrl } from "../refs/index.ts";
import {
	type CastEntry,
	extractCast,
	extractMentions,
	projectQuestForShow,
	type QuestFrontMatter,
	type QuestShowProjection,
} from "./index.ts";
import type { QuestState } from "./state.ts";

export interface FindParams {
	query?: string;
	since?: string;
	until?: string;
	field?: "started" | "updated" | "due" | "eta";
	priority?: string;
	kind?: string;
	status?: string;
	parent?: string;
	refType?: string;
}

/** Fill in `resolveRefQuery`'s defaults for a raw params bag. */
export function resolveRefQuery(params: FindParams): FindParams {
	return { ...params };
}

export interface FindHit {
	id: string;
	title: string | null;
	kind: string;
	status: string;
	priority: string;
	rank: number;
	updated: string;
	dir: string;
	summary?: string;
}

export interface QuestRowExpansion {
	summary?: string;
	cast: { role: string; subject: string }[];
	documents: { id: string; stage: string }[];
	recentJourney: { date: string; prose: string }[];
}

/** Build the expansion block for a single quest entry. */
export function buildRowExpansion(entry: QuestEntry): QuestRowExpansion {
	const cast = extractCast(entry.doc.body)
		.slice(0, 5)
		.map((c) => ({ role: c.role, subject: c.subject }));
	const documents = entry.documents.map((d) => ({
		id: d.doc.frontMatter.id,
		stage: d.doc.frontMatter.stage,
	}));
	const projection = projectQuestForShow(entry.doc);
	const recentJourney = projection.journey
		.slice(0, 3)
		.map((j) => ({ date: j.date, prose: j.prose }));
	const summary = projection.summary;
	return summary
		? { summary, cast, documents, recentJourney }
		: { cast, documents, recentJourney };
}

function parseDate(input?: string): Date | undefined {
	if (!input) return undefined;
	const d = new Date(input);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Match a quest against a free-text query, token by token. The
 * query is split on whitespace and every token must appear
 * somewhere across the quest's title, id, body or alias values
 * (an AND across a combined haystack), so a multi-word query no
 * longer demands one contiguous substring. An empty query
 * matches everything.
 */
export function matchesQuery(entry: QuestEntry, q: string): boolean {
	const tokens = q
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 0);
	if (tokens.length === 0) return true;
	const fm = entry.doc.frontMatter;
	const haystack = [
		entry.doc.title ?? "",
		fm.id,
		entry.doc.body,
		...fm.aliases.map((a) => a.value),
	]
		.join("\n")
		.toLowerCase();
	return tokens.every((token) => haystack.includes(token));
}

function fieldValue(
	fm: QuestFrontMatter,
	field: FindParams["field"],
): string | undefined {
	switch (field ?? "updated") {
		case "started":
			return fm.started;
		case "due":
			return fm.due;
		case "eta":
			return fm.eta;
		default:
			return fm.updated;
	}
}

/**
 * Search quests by free text, time range and frontmatter
 * filters. Returns every match ordered by `updated`
 * descending; pagination is the caller's concern so the
 * listing renderer can attach an accurate "and N more"
 * tail.
 */
export function findQuests(state: QuestState, params: FindParams): FindHit[] {
	return findQuestEntries(state, params).map((m) => m.hit);
}

/**
 * Same as `findQuests` but also returns the matching
 * `QuestEntry` so the caller can build the expanded view
 * without re-walking discovery.
 */
export function findQuestEntries(
	state: QuestState,
	params: FindParams,
): { hit: FindHit; entry: QuestEntry }[] {
	const { index } = discoverQuests(state.questsRoot);
	const since = parseDate(params.since);
	const until = parseDate(params.until);
	const matches: { hit: FindHit; entry: QuestEntry; _sortKey: number }[] = [];
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		if (params.kind && fm.kind !== params.kind) continue;
		if (params.status && fm.status !== params.status) continue;
		if (params.priority && fm.priority !== params.priority) continue;
		if (params.parent !== undefined) {
			const expected = params.parent === "null" ? null : params.parent;
			if (fm.parent !== expected) continue;
		}
		if (params.refType) {
			const types = new Set(fm.aliases.map((a) => a.type));
			if (!types.has(params.refType)) continue;
		}
		const fieldDate = parseDate(fieldValue(fm, params.field));
		if (since && fieldDate && fieldDate < since) continue;
		if (until && fieldDate && fieldDate > until) continue;
		if (params.query && !matchesQuery(entry, params.query)) continue;
		const projection = projectQuestForShow(entry.doc);
		const updatedDate = parseDate(fm.updated);
		const hit: FindHit = {
			id: fm.id,
			title: entry.doc.title ?? null,
			kind: fm.kind,
			status: fm.status,
			priority: fm.priority,
			rank: fm.rank,
			updated: fm.updated,
			dir: entry.dir,
		};
		if (projection.summary) hit.summary = projection.summary;
		matches.push({
			hit,
			entry,
			_sortKey: updatedDate ? -updatedDate.getTime() : 0,
		});
	}
	matches.sort((a, b) => a._sortKey - b._sortKey);
	return matches.map(({ hit, entry }) => ({ hit, entry }));
}

/** Convenience: load a single QuestEntry by id. */
export function getQuestEntry(
	state: QuestState,
	id: string,
): QuestEntry | undefined {
	const { index } = discoverQuests(state.questsRoot);
	return index.quests.get(id);
}

/** A quest that owns the located needle, and how it matched. */
export interface LocateHit {
	questId: string;
	questTitle: string | null;
	matchKind: "quest" | "document" | "alias" | "session";
	/** The concrete thing that matched: a doc path, alias ref or id. */
	detail?: string;
}

/**
 * Inverse index: resolve a needle to the quest that owns it. The
 * needle may be a quest id, a document id, an alias ref (either
 * `type:value` or a bare value) or a session id. Returns one hit
 * per match, so a needle that resolves to several quests (a session
 * id left on more than one after divergence, say) surfaces them all
 * rather than hiding the ambiguity behind a single answer.
 */
export function locateOwner(state: QuestState, needle: string): LocateHit[] {
	const trimmed = needle.trim();
	if (!trimmed) return [];
	const lower = trimmed.toLowerCase();
	const { index } = discoverQuests(state.questsRoot);
	const hits: LocateHit[] = [];
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		const title = entry.doc.title ?? null;
		if (fm.id === trimmed) {
			hits.push({ questId: fm.id, questTitle: title, matchKind: "quest" });
		}
		for (const d of entry.documents) {
			if (d.doc.frontMatter.id === trimmed) {
				hits.push({
					questId: fm.id,
					questTitle: title,
					matchKind: "document",
					detail: d.path,
				});
			}
		}
		for (const a of fm.aliases) {
			const ref = `${a.type}:${a.value}`;
			if (ref.toLowerCase() === lower || a.value.toLowerCase() === lower) {
				hits.push({
					questId: fm.id,
					questTitle: title,
					matchKind: "alias",
					detail: ref,
				});
			}
		}
		for (const s of fm.sessions) {
			if (s.id === trimmed) {
				hits.push({
					questId: fm.id,
					questTitle: title,
					matchKind: "session",
					detail: s.id,
				});
			}
		}
	}
	return hits;
}

/** One quest on the ancestor chain, nearest parent first. */
export interface AncestorHit {
	id: string;
	title: string | null;
	kind: string;
	status: string;
}

/**
 * Walk a quest's parent chain from its immediate parent up to the
 * root, so a caller can ask which epic a quest sits under. Nearest
 * parent comes first. A cycle (a store that drifted into one) or a
 * dangling parent stops the walk rather than looping forever. Returns
 * an empty list for a top-level quest, and undefined when the starting
 * id is unknown.
 */
export function ancestorsOf(
	state: QuestState,
	id: string,
): AncestorHit[] | undefined {
	const { index } = discoverQuests(state.questsRoot);
	const start = index.quests.get(id);
	if (!start) return undefined;
	const chain: AncestorHit[] = [];
	const seen = new Set<string>([id]);
	let parentId = start.doc.frontMatter.parent ?? null;
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId);
		const entry = index.quests.get(parentId);
		if (!entry) break;
		const fm = entry.doc.frontMatter;
		chain.push({
			id: fm.id,
			title: entry.doc.title ?? null,
			kind: fm.kind,
			status: fm.status,
		});
		parentId = fm.parent ?? null;
	}
	return chain;
}

export interface WhoParams {
	name?: string;
	role?: string;
	limit?: number;
}

export interface WhoHit {
	questId: string;
	questTitle: string | null;
	role: string;
	subject: string;
	prose: string;
}

/**
 * Return Cast bullets across quests matching the filter.
 * No internal cap: the caller owns pagination so a caller
 * who walks the whole tree gets the whole tree. Direct
 * library callers who want a cap pass `limit:`.
 *
 * Scaffold placeholder subjects (the `_name or @handle_`
 * sentinel a fresh quest's template writes) are already
 * filtered out at the parser level by `extractCast`, so
 * this function only sees real cast bullets.
 */
export function findPeople(state: QuestState, params: WhoParams): WhoHit[] {
	const { index } = discoverQuests(state.questsRoot);
	const nameNeedle = params.name?.toLowerCase();
	const roleNeedle = params.role?.toLowerCase();
	const out: WhoHit[] = [];
	const limit = params.limit ?? Number.POSITIVE_INFINITY;
	for (const entry of index.quests.values()) {
		const cast: CastEntry[] = extractCast(entry.doc.body);
		for (const c of cast) {
			if (roleNeedle && !c.role.toLowerCase().includes(roleNeedle)) continue;
			if (nameNeedle && !c.subject.toLowerCase().includes(nameNeedle)) continue;
			out.push({
				questId: entry.doc.frontMatter.id,
				questTitle: entry.doc.title ?? null,
				role: c.role,
				subject: c.subject,
				prose: c.prose,
			});
			if (out.length >= limit) return out;
		}
	}
	return out;
}

const URL_REGEX = /https?:\/\/[^\s<>()\]"']+/g;

function extractRawUrls(body: string, known: Set<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const match of body.matchAll(URL_REGEX)) {
		const url = match[0].replace(/[.,;:!?)\]]+$/, "");
		if (known.has(url)) continue;
		if (seen.has(url)) continue;
		seen.add(url);
		out.push(url);
	}
	return out;
}

export interface LinkSnippet {
	questId: string;
	questTitle: string | null;
	context: string;
	/**
	 * Relation the source document used to mention the
	 * loaded quest's id. `produced` when the mention was
	 * preceded by the → sigil; `reference` otherwise.
	 */
	relation: "produced" | "reference";
}

export interface LinkBundle {
	quests: { id: string; title: string | null }[];
	refs: { type: string; value: string; url?: string; why?: string }[];
	urls: string[];
}

export interface LinksParams {
	kind?: string;
	pattern?: string;
	priority?: string;
	status?: string;
}

export interface LinksResult {
	outgoing: LinkBundle;
	incoming: LinkSnippet[];
}

function bodySnippet(body: string, needle: string): string {
	const i = body.indexOf(needle);
	if (i < 0) return "";
	const start = Math.max(0, i - 60);
	const end = Math.min(body.length, i + needle.length + 60);
	return body.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Outgoing and incoming reference projection for the loaded quest. */
export function linksForLoaded(
	state: QuestState,
	params: LinksParams = {},
): LinksResult | undefined {
	if (!state.questId) return undefined;
	const { index } = discoverQuests(state.questsRoot);
	return linksForQuest(index, state.questId, params);
}

/** Outgoing and incoming reference projection for any quest by id. */
export function linksForQuest(
	index: QuestIndex,
	questId: string,
	params: LinksParams,
): LinksResult | undefined {
	const me = index.quests.get(questId);
	if (!me) return undefined;
	const myMentions = extractMentions(me.doc.body);
	const knownRefUrls = new Set<string>();
	for (const r of myMentions.refs) {
		const u = urlForRef(r);
		if (u) knownRefUrls.add(u);
	}
	// Only ids that resolve to a real quest belong here. A mentioned
	// document id (PLAN-, RSCH-, BRIF-, RPRT-) is not a quest, so it
	// would otherwise render as a titleless quest row.
	const quests = myMentions.ids
		.filter((id) => id !== questId)
		.filter((id) => index.quests.has(id))
		.map((id) => ({ id, title: index.quests.get(id)?.doc.title ?? null }));
	const refs = myMentions.refs
		.filter((r) => !params.kind || r.type === params.kind)
		.filter((r) => !params.pattern || r.value.includes(params.pattern))
		.map((r) => {
			const u = urlForRef(r);
			if (u) return { ...r, url: u };
			// Carried so the listing can say a link is missing and why,
			// rather than showing a bare ref that looks the same as one
			// whose type simply has no URL form.
			const why = whyRefHasNoUrl(r);
			return why ? { ...r, why } : { ...r };
		});
	let urls = extractRawUrls(me.doc.body, knownRefUrls);
	const pattern = params.pattern;
	if (pattern) urls = urls.filter((u) => u.includes(pattern));

	const incoming: LinkSnippet[] = [];
	for (const entry of index.quests.values()) {
		if (entry.doc.frontMatter.id === questId) continue;
		if (params.priority && entry.doc.frontMatter.priority !== params.priority)
			continue;
		if (params.status && entry.doc.frontMatter.status !== params.status)
			continue;
		const mentions = extractMentions(entry.doc.body);
		const match = mentions.idMentions.find((m) => m.id === questId);
		if (match) {
			incoming.push({
				questId: entry.doc.frontMatter.id,
				questTitle: entry.doc.title ?? null,
				context: bodySnippet(entry.doc.body, questId),
				relation: match.relation,
			});
		}
	}
	return { outgoing: { quests, refs, urls }, incoming };
}

export interface DocumentSummary {
	id: string;
	kind: string;
	stage: string;
	title: string | null;
	path: string;
	updated: string;
}

function summariseDocuments(
	documents: QuestDocumentEntry[],
): DocumentSummary[] {
	return documents
		.map((d) => ({
			id: d.doc.frontMatter.id,
			kind: d.doc.frontMatter.kind,
			stage: d.doc.frontMatter.stage,
			title: d.doc.title ?? null,
			path: d.path,
			updated: d.doc.frontMatter.updated,
		}))
		.sort((a, b) => (a.updated < b.updated ? 1 : -1));
}

export interface QuestShowResult {
	frontMatter: QuestFrontMatter;
	title: string | null;
	summary: string | null;
	purpose: string | null;
	cast: CastEntry[];
	journey: { date: string; prose: string }[];
	milestones: { total: number; done: number };
	documents: DocumentSummary[];
	links: LinkBundle;
	echoes: LinkSnippet[];
}

/** Build the full `show` projection for the loaded quest. */
export function showLoaded(state: QuestState): QuestShowResult | undefined {
	if (!state.questId) return undefined;
	return showQuestById(state, state.questId);
}

/**
 * Build the full `show` projection for any quest by id, without
 * touching the loaded state. This is what lets `show <id>`
 * inspect a sibling read-only instead of having to load it.
 *
 * Deliberately leaner than pi's own `showQuestById`: no attached-
 * session liveness (that needs pi's session log) and cast subjects
 * are not resolved to identities (that needs `lib/people`, not yet
 * ported). Both are adapter-side enrichments a host with a session
 * log or an identity registry can layer on top of this projection.
 */
export function showQuestById(
	state: QuestState,
	questId: string,
): QuestShowResult | undefined {
	const { index } = discoverQuests(state.questsRoot);
	const me = index.quests.get(questId);
	if (!me) return undefined;
	const links = linksForQuest(index, questId, {});
	const projection: QuestShowProjection = projectQuestForShow(me.doc);
	return {
		frontMatter: me.doc.frontMatter,
		title: me.doc.title ?? null,
		summary: projection.summary ?? null,
		purpose: projection.purpose ?? null,
		cast: projection.cast,
		journey: projection.journey.slice(0, 5),
		milestones: projection.milestones,
		documents: summariseDocuments(me.documents),
		links: links?.outgoing ?? { quests: [], refs: [], urls: [] },
		echoes: links?.incoming ?? [],
	};
}

export interface TreeNode {
	id: string;
	title: string | null;
	kind: string;
	status: string;
	priority: string;
	rank: number;
	children: TreeNode[];
}

function buildSubtree(index: QuestIndex, parentKey: string): TreeNode[] {
	const ids = index.children.get(parentKey) ?? [];
	const entries = ids
		.map((id) => index.quests.get(id))
		.filter((e): e is QuestEntry => e !== undefined);
	entries.sort((a, b) => a.doc.frontMatter.rank - b.doc.frontMatter.rank);
	return entries.map((e) => ({
		id: e.doc.frontMatter.id,
		title: e.doc.title ?? null,
		kind: e.doc.frontMatter.kind,
		status: e.doc.frontMatter.status,
		priority: e.doc.frontMatter.priority,
		rank: e.doc.frontMatter.rank,
		children: buildSubtree(index, e.doc.frontMatter.id),
	}));
}

/** Tree projection across the whole quest tree.
 *
 * Any quest whose `parent` points at an id not in the
 * index is collected under a synthetic root with a
 * `parent` of `null` (a deleted or missing parent
 * shouldn't make the children disappear from the tree
 * view). The orphans group sits after the legitimate
 * top-level quests so the user notices it.
 */
export function treeAll(index: QuestIndex): TreeNode[] {
	const top = buildSubtree(index, "");
	const orphans: TreeNode[] = [];
	for (const [parentKey, ids] of index.children) {
		if (parentKey === "") continue;
		if (index.quests.has(parentKey)) continue;
		for (const id of ids) {
			const entry = index.quests.get(id);
			if (!entry) continue;
			orphans.push({
				id: entry.doc.frontMatter.id,
				title: entry.doc.title ?? null,
				kind: entry.doc.frontMatter.kind,
				status: entry.doc.frontMatter.status,
				priority: entry.doc.frontMatter.priority,
				rank: entry.doc.frontMatter.rank,
				children: buildSubtree(index, entry.doc.frontMatter.id),
			});
		}
	}
	if (orphans.length === 0) return top;
	orphans.sort((a, b) => a.id.localeCompare(b.id));
	return [
		...top,
		{
			id: "(orphans)",
			title: "Quests whose parent is missing from the index",
			kind: "quest",
			status: "active",
			priority: "someday",
			rank: Number.MAX_SAFE_INTEGER,
			children: orphans,
		},
	];
}

/** Subtree rooted at a single quest id. */
export function expandQuest(
	index: QuestIndex,
	id: string,
): TreeNode | undefined {
	const entry = index.quests.get(id);
	if (!entry) return undefined;
	return {
		id: entry.doc.frontMatter.id,
		title: entry.doc.title ?? null,
		kind: entry.doc.frontMatter.kind,
		status: entry.doc.frontMatter.status,
		priority: entry.doc.frontMatter.priority,
		rank: entry.doc.frontMatter.rank,
		children: buildSubtree(index, entry.doc.frontMatter.id),
	};
}
