/**
 * Read-only lookup helpers for the `find`, `who`, `links`,
 * `tree`, `expand` and `show` actions of the quest tool.
 * Pure projections over the discovery walk's index plus
 * the alias index. All filtering and ranking happens here;
 * the tool only dispatches.
 */

import {
	discoverQuests,
	type QuestDocumentEntry,
	type QuestEntry,
	type QuestIndex,
} from "../../lib/internal/quest/discovery.js";
import {
	getResolutionFallback,
	type Identity,
	resolveIdentity,
} from "../../lib/people/index.js";
import {
	type CastEntry,
	extractCast,
	extractMentions,
	extractSectionParagraph,
	type QuestFrontMatter,
	type QuestSession,
} from "../../lib/quest/index.js";
import { urlForRef } from "../../lib/refs/index.js";
import type { RowCast, RowDocument, RowJourney } from "./render-rows.js";
import type { QuestState } from "./state.js";

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
	limit?: number;
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

/**
 * The pure-data shape the listing verbs add on top of a
 * brief row when the caller asks for `expanded: true`.
 * Built by walking a single quest entry; no I/O.
 */
export interface QuestRowExpansion {
	summary?: string;
	cast: RowCast[];
	documents: RowDocument[];
	recentJourney: RowJourney[];
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
	const recentJourney = extractJourneyEntries(entry.doc.body, 3);
	const summary = firstSummaryLine(entry.doc.body);
	return summary
		? { summary, cast, documents, recentJourney }
		: { cast, documents, recentJourney };
}

function parseDate(input?: string): Date | undefined {
	if (!input) return undefined;
	const d = new Date(input);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

function matchesQuery(entry: QuestEntry, q: string): boolean {
	const needle = q.toLowerCase();
	const fm = entry.doc.frontMatter;
	if (entry.doc.title?.toLowerCase().includes(needle)) return true;
	if (fm.id.toLowerCase().includes(needle)) return true;
	if (entry.doc.body.toLowerCase().includes(needle)) return true;
	for (const alias of fm.aliases) {
		if (alias.value.toLowerCase().includes(needle)) return true;
	}
	return false;
}

function firstSummaryLine(body: string): string | undefined {
	const match = /##\s+(?:\S+\s+)?Summary\s*\n+([^\n]+)/.exec(body);
	return match?.[1]?.trim();
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
 * `QuestEntry` so the verb can build the expanded view
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
		const summary = firstSummaryLine(entry.doc.body);
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
		if (summary) hit.summary = summary;
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

const DEFAULT_WHO_LIMIT = 50;

/** Return Cast bullets across quests matching the filter. */
export function findPeople(state: QuestState, params: WhoParams): WhoHit[] {
	const { index } = discoverQuests(state.questsRoot);
	const nameNeedle = params.name?.toLowerCase();
	const roleNeedle = params.role?.toLowerCase();
	const out: WhoHit[] = [];
	const limit = params.limit ?? DEFAULT_WHO_LIMIT;
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
}

export interface LinkBundle {
	quests: { id: string; title: string | null }[];
	refs: { type: string; value: string; url?: string }[];
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

function linksForQuest(
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
	const quests = myMentions.ids
		.filter((id) => id !== questId)
		.map((id) => ({ id, title: index.quests.get(id)?.doc.title ?? null }));
	const refs = myMentions.refs
		.filter((r) => !params.kind || r.type === params.kind)
		.filter((r) => !params.pattern || r.value.includes(params.pattern))
		.map((r) => {
			const u = urlForRef(r);
			return u ? { ...r, url: u } : { ...r };
		});
	let urls = extractRawUrls(me.doc.body, knownRefUrls);
	if (params.pattern) urls = urls.filter((u) => u.includes(params.pattern));

	const incoming: LinkSnippet[] = [];
	for (const entry of index.quests.values()) {
		if (entry.doc.frontMatter.id === questId) continue;
		if (params.priority && entry.doc.frontMatter.priority !== params.priority)
			continue;
		if (params.status && entry.doc.frontMatter.status !== params.status)
			continue;
		const mentions = extractMentions(entry.doc.body);
		if (mentions.ids.includes(questId)) {
			incoming.push({
				questId: entry.doc.frontMatter.id,
				questTitle: entry.doc.title ?? null,
				context: bodySnippet(entry.doc.body, questId),
			});
		}
	}
	return { outgoing: { quests, refs, urls }, incoming };
}

/** Active sessions on the loaded quest. */
function activeSessions(sessions: QuestSession[]): QuestSession[] {
	return sessions.filter((s) => s.status !== "detached");
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

/** Cast bullet enriched with an attempted identity resolution. */
export interface ResolvedCastEntry extends CastEntry {
	/** Identity id when a resolver matched the subject. */
	identityId?: string;
	/** Resolver that supplied the identity. */
	via?: string;
}

export interface QuestShowResult {
	frontMatter: QuestFrontMatter;
	title: string | null;
	summary: string | null;
	purpose: string | null;
	cast: ResolvedCastEntry[];
	unresolvedCast: string[];
	resolutionFallback: "silent" | "warn" | "ask";
	journey: { date: string; prose: string }[];
	milestones: { total: number; done: number };
	documents: DocumentSummary[];
	sessions: QuestSession[];
	links: LinkBundle;
	echoes: LinkSnippet[];
}

async function resolveCast(cast: CastEntry[]): Promise<{
	cast: ResolvedCastEntry[];
	unresolved: string[];
}> {
	const out: ResolvedCastEntry[] = [];
	const unresolved: string[] = [];
	for (const entry of cast) {
		const hit = await resolveIdentity(entry.subject, { hint: "handle" });
		if (hit) {
			out.push({ ...entry, identityId: hit.identity.id, via: hit.via });
			continue;
		}
		out.push({ ...entry });
		unresolved.push(entry.subject);
	}
	return { cast: out, unresolved };
}

/** Build the full `show` projection for the loaded quest. */
export async function showLoaded(
	state: QuestState,
): Promise<QuestShowResult | undefined> {
	if (!state.questId) return undefined;
	const { index } = discoverQuests(state.questsRoot);
	const me = index.quests.get(state.questId);
	if (!me) return undefined;
	const links = linksForQuest(index, state.questId, {});
	const { cast, unresolved } = await resolveCast(extractCast(me.doc.body));
	const journey = extractJourneyEntries(me.doc.body, 5);
	return {
		frontMatter: me.doc.frontMatter,
		title: me.doc.title ?? null,
		summary: extractSectionParagraph(me.doc.body, "summary") ?? null,
		purpose: extractSectionParagraph(me.doc.body, "purpose") ?? null,
		cast,
		unresolvedCast: unresolved,
		resolutionFallback: getResolutionFallback(),
		journey,
		milestones: milestoneCounts(me.doc.body),
		documents: summariseDocuments(me.documents),
		sessions: activeSessions(me.doc.frontMatter.sessions),
		links: links?.outgoing ?? { quests: [], refs: [], urls: [] },
		echoes: links?.incoming ?? [],
	};
}

// `Identity` is exported for callers that want to inspect
// the resolver chain's output directly.
export type { Identity };

function milestoneCounts(body: string): { total: number; done: number } {
	const rx = /^\s*-\s+\[([ xX])\]/gm;
	let total = 0;
	let done = 0;
	for (let m = rx.exec(body); m !== null; m = rx.exec(body)) {
		total++;
		if (m[1].toLowerCase() === "x") done++;
	}
	return { total, done };
}

/** Pull recent Journey bullets from a quest's body. */
export function extractJourneyEntries(
	body: string,
	limit: number,
): { date: string; prose: string }[] {
	const journeyHeading =
		/##\s+(?:[\u{1F300}-\u{1FFFF}]\s+)?Journey\s*\n([\s\S]*?)(?=\n##\s|$)/u;
	const m = journeyHeading.exec(body);
	if (!m) return [];
	const section = m[1];
	const bullets = section.split(/\n(?=- \*\*)/);
	const out: { date: string; prose: string }[] = [];
	for (const bullet of bullets) {
		const match = /^-\s+\*\*([\d-]+)\*\*:\s*([\s\S]*)$/.exec(bullet.trim());
		if (match) {
			out.push({ date: match[1], prose: match[2].trim() });
			if (out.length >= limit) break;
		}
	}
	return out;
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
export function treeAll(state: QuestState): TreeNode[] {
	const { index } = discoverQuests(state.questsRoot);
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
	state: QuestState,
	id: string,
): TreeNode | undefined {
	const { index } = discoverQuests(state.questsRoot);
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
