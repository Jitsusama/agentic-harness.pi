/**
 * Read-only lookup helpers for the `find`, `who`, `links`,
 * `tree`, `expand` and `show` actions of the quest tool.
 * Pure projections over the discovery walk's index plus
 * the alias index. All filtering and ranking happens here;
 * the tool only dispatches.
 */

import { sessionsDir } from "../../lib/internal/paths.js";
import {
	discoverQuests,
	type QuestDocumentEntry,
	type QuestEntry,
	type QuestIndex,
} from "../../lib/internal/quest/discovery.js";
import {
	type SessionSummary,
	summariseSessions,
} from "../../lib/internal/quest/reopen.js";
import {
	deriveLiveness,
	indexSessionFiles,
	questLastActivity,
	type SessionLiveness,
} from "../../lib/internal/quest/session-liveness.js";
import { authoritativeQuestFromLog } from "../../lib/internal/quest/session-ownership.js";
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
import { parseRef, urlForRef } from "../../lib/refs/index.js";
import { buildSessionSnapshot } from "./liveness.js";
import type { RowCast, RowDocument, RowJourney } from "./render-rows.js";
import type { QuestState } from "./state.js";

export interface FindParams {
	query?: string;
	since?: string;
	until?: string;
	field?: "started" | "updated" | "due" | "eta" | "activity";
	priority?: string;
	kind?: string;
	status?: string;
	parent?: string;
	refType?: string;
	limit?: number;
}

/**
 * Rewrite a find query that is a URL or ref-shaped string to the
 * canonical alias value its ref type stores, and pin the ref type,
 * so a search by URL resolves the quest that carries that alias.
 * A plain-text query (nothing the ref registry recognises) is
 * returned unchanged.
 */
export function resolveRefQuery(params: FindParams): FindParams {
	if (!params.query) return params;
	const ref = parseRef(params.query);
	if (!ref) return params;
	return { ...params, query: ref.value, refType: ref.type };
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
	/** Newest session activity, populated only for activity queries. */
	lastActivity?: string;
}

/**
 * The pure-data shape the listing verbs add on top of a
 * brief row. Threaded through to the listing payload so
 * `renderResult` can paint the expanded view on Ctrl-O
 * without re-walking discovery. Built by walking a single
 * quest entry; no I/O.
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
	const byActivity = params.field === "activity";
	// Activity is read from the session store. Index the store once
	// for the whole query rather than re-listing it per quest, and
	// only when the caller actually filters or sorts by activity.
	const activityIndex = byActivity
		? indexSessionFiles(sessionsDir())
		: undefined;
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
		const lastActivity =
			byActivity && activityIndex
				? questLastActivity(fm.sessions, activityIndex)
				: undefined;
		const fieldDate = byActivity
			? parseDate(lastActivity)
			: parseDate(fieldValue(fm, params.field));
		// Under an activity window, a quest with no recorded activity
		// is not "active in this window" and is excluded, rather than
		// slipping through the date guards on an undefined date.
		if (byActivity && (since || until) && !fieldDate) continue;
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
		if (lastActivity) hit.lastActivity = lastActivity;
		const sortBasis = byActivity ? parseDate(lastActivity) : updatedDate;
		matches.push({
			hit,
			entry,
			_sortKey: sortBasis ? -sortBasis.getTime() : 0,
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

/** A quest currently being worked on, with its liveliest session. */
export interface WorkspaceEntry {
	questId: string;
	title: string | null;
	kind: string;
	status: string;
	priority: string;
	liveness: SessionLiveness;
	sessionId: string;
	cwd?: string;
	lastActivity?: string;
}

/**
 * A session counts as active work when it is live or idle: a pi
 * running against the quest now, or one recently active.
 */
function isActiveWork(liveness: SessionLiveness): boolean {
	return liveness === "live" || liveness === "idle";
}

/** Rank for workspace ordering: live first, then idle, then the rest. */
function livenessRank(liveness: SessionLiveness): number {
	if (liveness === "live") return 0;
	if (liveness === "idle") return 1;
	return 2;
}

/**
 * The live workspace: one row per non-detached session of every quest
 * that has active work, so two live panes on one quest read as two
 * rows and a crashed pane shows beside its live sibling rather than
 * being collapsed away. A quest with no live or idle session is left
 * out entirely. Rows are ordered live first, then by recency.
 */
export async function workspaceQuests(
	state: QuestState,
): Promise<WorkspaceEntry[]> {
	const { index } = discoverQuests(state.questsRoot);
	// One snapshot across every quest's sessions: derivation is keyed
	// by session id, so a single store walk and probe pass serves all
	// quests rather than re-indexing per quest.
	const allSessions = [...index.quests.values()].flatMap(
		(entry) => entry.doc.frontMatter.sessions,
	);
	const snapshot = await buildSessionSnapshot(allSessions);
	const entries: WorkspaceEntry[] = [];
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		const views = fm.sessions
			.map((s) => deriveLiveness(s, snapshot))
			.filter((v) => v.liveness !== "detached")
			.sort((a, b) =>
				byRow(a.liveness, a.lastActivity, b.liveness, b.lastActivity),
			);
		// A quest earns a place in the workspace only when it has a live
		// or idle session; its crashed and unknown siblings then ride
		// along so a crash shows next to the work it died beside.
		if (!views.some((v) => isActiveWork(v.liveness))) continue;
		for (const view of views) {
			entries.push({
				questId: fm.id,
				title: entry.doc.title ?? null,
				kind: fm.kind,
				status: fm.status,
				priority: fm.priority,
				liveness: view.liveness,
				sessionId: view.id,
				...(view.cwd ? { cwd: view.cwd } : {}),
				...(view.lastActivity ? { lastActivity: view.lastActivity } : {}),
			});
		}
	}
	return entries.sort((a, b) =>
		byRow(a.liveness, a.lastActivity, b.liveness, b.lastActivity),
	);
}

/** Order rows live-first, then idle, then the rest, newest activity first. */
function byRow(
	aLiveness: SessionLiveness,
	aActivity: string | undefined,
	bLiveness: SessionLiveness,
	bActivity: string | undefined,
): number {
	const rank = livenessRank(aLiveness) - livenessRank(bLiveness);
	if (rank !== 0) return rank;
	const at = aActivity ? Date.parse(aActivity) : 0;
	const bt = bActivity ? Date.parse(bActivity) : 0;
	return bt - at;
}

/** A session listed active on more than one quest. */
export interface SessionDivergence {
	sessionId: string;
	questIds: string[];
}

/**
 * Scan the store for session-to-quest divergence: a session id that
 * reads active on more than one quest at once. Reconcile-on-load
 * repairs this the moment a session loads a quest, but until then an
 * operator has no way to see it; this surfaces it read-only, without
 * loading or mutating anything. A single-membership store returns an
 * empty list.
 */
export function auditSessionMembership(state: QuestState): SessionDivergence[] {
	const { index } = discoverQuests(state.questsRoot);
	const bySession = new Map<string, string[]>();
	for (const entry of index.quests.values()) {
		for (const s of entry.doc.frontMatter.sessions) {
			if (s.status === "active") {
				const list = bySession.get(s.id) ?? [];
				list.push(entry.doc.frontMatter.id);
				bySession.set(s.id, list);
			}
		}
	}
	const divergences: SessionDivergence[] = [];
	for (const [sessionId, questIds] of bySession) {
		if (questIds.length > 1) {
			divergences.push({ sessionId, questIds: questIds.sort() });
		}
	}
	return divergences;
}

/** One divergent session the repair can resolve from its log. */
export interface ResolvableSession {
	sessionId: string;
	/** The quest the session's log names as its owner; the one kept. */
	keep: string;
	/** The quests to detach the session from. */
	detachFrom: string[];
}

/** A repair plan for the store's session-to-quest divergence. */
export interface SessionRepairPlan {
	resolvable: ResolvableSession[];
	conflicted: SessionDivergence[];
}

/**
 * Plan how to repair sessions active on more than one quest. The
 * session's own log is the authority: when its last quest-workflow
 * entry names one of the claimants, that quest is kept and the others
 * are planned for detach. When the log is missing, cleared, or names
 * a quest that is not a claimant, the divergence cannot be resolved
 * from authority and is reported conflicted, never auto-assigned.
 * Read-only: it computes the plan and mutates nothing.
 */
export function planSessionRepair(state: QuestState): SessionRepairPlan {
	const divergences = auditSessionMembership(state);
	const logIndex = indexSessionFiles(sessionsDir());
	const resolvable: ResolvableSession[] = [];
	const conflicted: SessionDivergence[] = [];
	for (const divergence of divergences) {
		const logPath = logIndex.get(divergence.sessionId);
		const owner = logPath ? authoritativeQuestFromLog(logPath) : undefined;
		if (owner && divergence.questIds.includes(owner)) {
			resolvable.push({
				sessionId: divergence.sessionId,
				keep: owner,
				detachFrom: divergence.questIds.filter((id) => id !== owner),
			});
		} else {
			conflicted.push(divergence);
		}
	}
	return { resolvable, conflicted };
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
 * No internal cap: the verb owns pagination so a caller
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

/**
 * Project a quest's attached sessions for display: derive each
 * session's liveness from its log in the pi session store, then
 * summarise (order newest-first and flag the resume target). Every
 * session is reported, including dead no-log ones; pruning phantoms
 * is the load verb's job, not this view's. Reads the store fresh
 * against the current time.
 */
async function projectSessions(
	sessions: QuestSession[],
): Promise<SessionSummary[]> {
	const snapshot = await buildSessionSnapshot(sessions);
	return summariseSessions(sessions.map((s) => deriveLiveness(s, snapshot)));
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
	sessions: SessionSummary[];
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
	return showQuestById(state, state.questId);
}

/**
 * Build the full `show` projection for any quest by id, without
 * touching the loaded state. This is what lets `show <id>`
 * inspect a sibling read-only instead of having to load it.
 */
export async function showQuestById(
	state: QuestState,
	questId: string,
): Promise<QuestShowResult | undefined> {
	const { index } = discoverQuests(state.questsRoot);
	const me = index.quests.get(questId);
	if (!me) return undefined;
	const links = linksForQuest(index, questId, {});
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
		sessions: await projectSessions(me.doc.frontMatter.sessions),
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
