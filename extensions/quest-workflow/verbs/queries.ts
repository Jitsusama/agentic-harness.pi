/**
 * Read-only query verbs: tree (whole forest), expand (one
 * subtree), find (by query/date/field), who (by role/name)
 * and links (incoming/outgoing for the loaded quest). Plus
 * the subdirForDocumentId helper used by focus and other
 * lifecycle verbs to map a document id to its storage
 * subdir.
 */

import {
	discoverQuests,
	type QuestIndex,
} from "../../../lib/internal/quest/discovery.ts";
import {
	restoreRecipe,
	type SessionRecord,
	wasLost,
} from "../../../lib/internal/quest/session-registry.ts";
import { count } from "../../../lib/ui/count.ts";
import {
	ancestorsOf,
	buildRowExpansion,
	expandQuest,
	findPeople,
	findQuestEntries,
	linksForLoaded,
	locateOwner,
	recentSessions,
	resolveRefQuery,
	type TreeNode,
	treeAll,
	workspaceQuests,
} from "../lookup.ts";
import {
	type ListingDetails,
	type ListingFlatRow,
	paginate,
	type QuestRowBrief,
	renderListing,
	renderRowBrief,
} from "../render-rows.ts";
import {
	pruneClosedRecords,
	recentlyClosedSessions,
	reopenLostSessions,
	restorableSessions,
	seedLiveSessions,
} from "../session-registry.ts";
import type { QuestState } from "../state.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

export function find(state: QuestState, params: QuestToolParams): QuestResult {
	const ALLOWED_FIELDS = ["started", "updated", "due", "eta", "activity"];
	if (params.field && !ALLOWED_FIELDS.includes(params.field)) {
		return refuse(
			`Unknown field "${params.field}". Use started, updated, due, eta or activity.`,
		);
	}
	const field = params.field as
		| "started"
		| "updated"
		| "due"
		| "eta"
		| "activity"
		| undefined;
	const matches = findQuestEntries(
		state,
		resolveRefQuery({
			query: params.query,
			since: params.since,
			until: params.until,
			field,
			priority: params.priority,
			kind: params.kind,
			status: params.status,
			parent: params.parent,
			refType: params.refType,
		}),
	);
	const view = paginate(matches, {
		limit: params.limit,
		offset: params.offset,
	});
	const rows: ListingFlatRow[] = view.rows.map(({ hit, entry }) => ({
		id: hit.id,
		kind: hit.kind as ListingFlatRow["kind"],
		status: hit.status as ListingFlatRow["status"],
		title: hit.title,
		priority: hit.priority,
		parent: entry.doc.frontMatter.parent,
		updated: hit.updated,
		depth: 0,
		...buildRowExpansion(entry),
	}));
	const rendered = rows.map((row) =>
		renderRowBrief({
			id: row.id,
			kind: row.kind,
			status: row.status,
			priority: row.priority,
			title: row.title,
		}),
	);
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

export function who(state: QuestState, params: QuestToolParams): QuestResult {
	const hits = findPeople(state, { name: params.name, role: params.role });
	const view = paginate(hits, {
		limit: params.limit,
		offset: params.offset,
	});
	const rendered = view.rows.map((h) =>
		`${h.subject} (${h.role}) - ${h.questId} ${h.questTitle ?? ""}`.trimEnd(),
	);
	const hint = params.name || params.role ? " matching filter" : "";
	if (view.total === 0) {
		return ok(`(no cast bullets${hint})`, {
			hits: view.rows,
			total: view.total,
			offset: view.offset,
			limit: view.limit,
			remaining: view.remaining,
		});
	}
	return ok(renderListing(rendered, view), {
		hits: view.rows,
		total: view.total,
		offset: view.offset,
		limit: view.limit,
		remaining: view.remaining,
	});
}

export function linksAction(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
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
	const lines: string[] = [];
	lines.push(
		`Outgoing (${outgoingCount}): ${count(links.outgoing.quests.length, "quest")}, ${count(links.outgoing.refs.length, "ref")}, ${count(links.outgoing.urls.length, "url")}.`,
	);
	for (const q of links.outgoing.quests) {
		lines.push(`  -> ${q.id} ${q.title ?? ""}`.trimEnd());
	}
	for (const r of links.outgoing.refs) {
		lines.push(`  -> ${r.type}:${r.value}${r.url ? ` (${r.url})` : ""}`);
		// A ref that should have had a link and does not says so here.
		// Silently rendering it beside the ones that resolved is how 621
		// of these went unnoticed for months.
		if (r.why) lines.push(`     no link: ${r.why}`);
	}
	for (const u of links.outgoing.urls) {
		lines.push(`  -> ${u}`);
	}
	lines.push("");
	lines.push(`Incoming (${links.incoming.length}):`);
	for (const i of links.incoming) {
		const ctx = i.context ? `\n     ${i.context}` : "";
		lines.push(`  <- ${i.questId} ${i.questTitle ?? ""}${ctx}`.trimEnd());
	}
	return ok(lines.join("\n"), { links });
}

export function locate(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const needle = (params.id ?? params.query ?? "").trim();
	if (!needle) {
		return refuse(
			"Pass the thing to locate in `id` (or `query`): a quest id, document id, alias ref or session id.",
		);
	}
	const hits = locateOwner(state, needle);
	if (hits.length === 0) {
		return ok(`No quest owns "${needle}".`, { hits });
	}
	const lines = hits.map(
		(h) =>
			`${h.matchKind}: ${h.questId} ${h.questTitle ?? ""}`.trimEnd() +
			(h.detail ? ` (${h.detail})` : ""),
	);
	return ok(lines.join("\n"), { hits });
}

export async function workspace(state: QuestState): Promise<QuestResult> {
	const entries = await workspaceQuests(state);
	if (entries.length === 0) {
		return ok("No quests are being worked on right now.", { workspace: [] });
	}
	const lines = entries.map((e) => {
		const where = e.cwd ? ` ${e.cwd}` : "";
		return `${workspaceMark(e.liveness)} ${e.questId} ${e.title ?? ""} [${e.status}]${where}`.trimEnd();
	});
	return ok(lines.join("\n"), { workspace: entries });
}

/**
 * How many terminals restore will open in one go.
 *
 * Sized above a heavy but real working set, since the crash this
 * exists for took twelve tabs, and well below the point where the
 * screen fills with windows nobody asked for.
 */
const MAX_REOPEN_AT_ONCE = 16;

/**
 * How many recently closed sessions restore lists. Enough for an
 * evening's tabs, few enough that the lost ones above stay the thing
 * the eye lands on.
 */
const RECENTLY_CLOSED_SHOWN = 10;

/**
 * The backstop under the lost sessions: what was closed on purpose in
 * the last day, as lines to run. Restore never reopens these unasked,
 * but pi reports some signals as a quit, so a tab that was taken away
 * can land here, and listing it keeps it one line away.
 */
function recentlyClosedSection(closed: readonly SessionRecord[]): string[] {
	if (closed.length === 0) return [];
	const shown = closed.slice(0, RECENTLY_CLOSED_SHOWN);
	const lines = [
		"",
		`Closed in the last day, left alone unless you ask (${count(closed.length, "session")}):`,
		...restoreRecipe(shown),
	];
	if (closed.length > shown.length) {
		lines.push(`and ${closed.length - shown.length} more.`);
	}
	return lines;
}

/**
 * The sessions an `id` list names, out of those restore would list.
 *
 * Each name is a session id or the front of one, since the ids are
 * long and the listing shows them whole. A name that matches nothing
 * or matches several is refused outright rather than guessed at,
 * because a wrong guess opens a terminal.
 */
function namedSessions(
	candidates: readonly SessionRecord[],
	ids: string,
): { ok: true; records: SessionRecord[] } | { ok: false; guidance: string } {
	const picked = new Map<string, SessionRecord>();
	for (const name of ids.split(",").map((part) => part.trim())) {
		if (!name) continue;
		const matches = candidates.filter((r) => r.sessionId.startsWith(name));
		if (matches.length === 0) {
			return {
				ok: false,
				guidance: `No lost or recently closed session matches "${name}". Run restore without id to see the ones it knows.`,
			};
		}
		if (matches.length > 1) {
			return {
				ok: false,
				guidance: `"${name}" matches more than one session: ${matches.map((r) => r.sessionId).join(", ")}. Give more of the id.`,
			};
		}
		const [match] = matches as [SessionRecord];
		picked.set(match.sessionId, match);
	}
	if (picked.size === 0) {
		return { ok: false, guidance: "id named no sessions." };
	}
	return { ok: true, records: [...picked.values()] };
}

/** Every session any quest claims, paired with the quest claiming it. */
function claimedSessions(state: QuestState) {
	const { index } = discoverQuests(state.questsRoot);
	return [...index.quests.values()].flatMap((entry) =>
		entry.doc.frontMatter.sessions.map((session) => ({
			questId: entry.doc.frontMatter.id,
			session,
		})),
	);
}

export async function restore(
	state: QuestState,
	opts: { act?: boolean; ids?: string } = {},
): Promise<QuestResult> {
	// Seed before asking, so tabs that were already open when the
	// registry arrived are known to be open rather than absent, and
	// prune after, so a window that has passed is not carried by every
	// later read.
	seedLiveSessions(claimedSessions(state));
	const allLost = restorableSessions();
	const allClosed = recentlyClosedSessions();
	pruneClosedRecords(state.sessionRetentionDays);
	// Naming sessions makes them the whole set: listed alone, and the
	// ones force reopens, whichever list they came from.
	let toRestore = allLost;
	let closed = allClosed;
	if (opts.ids !== undefined) {
		const named = namedSessions([...allLost, ...allClosed], opts.ids);
		if (!named.ok) return refuse(named.guidance);
		toRestore = named.records;
		closed = [];
	}
	const closedSection = recentlyClosedSection(closed);
	if (toRestore.length === 0) {
		return ok(
			["No sessions were lost; nothing to restore.", ...closedSection].join(
				"\n",
			),
			{ restore: { toRestore: [], recipe: [], recentlyClosed: closed } },
		);
	}
	const recipe = restoreRecipe(toRestore);
	const rows = toRestore.map(
		(record) =>
			`- ${record.quest ?? "(no quest)"} ${record.cwd} (session ${record.sessionId}, ${wasLost(record) ? "lost" : "closed"} ${record.closedAt})`,
	);
	if (!opts.act) {
		const body = [
			`${count(toRestore.length, "session")} to restore:`,
			...rows,
			"",
			"Run to reopen them, or pass force to have restore do it:",
			...recipe,
			...closedSection,
		].join("\n");
		return ok(body, {
			restore: { toRestore, recipe, recentlyClosed: closed },
		});
	}
	if (toRestore.length > MAX_REOPEN_AT_ONCE) {
		// Refuse whole rather than stopping halfway. A registry that has
		// gone wrong, or a machine off for a month, should not be able
		// to turn one verb into a screenful of windows, and a partial
		// reopen would leave the user working out which half happened.
		return ok(
			[
				`${toRestore.length} sessions to restore, more than the ${MAX_REOPEN_AT_ONCE} restore will open at once.`,
				"Reopen the ones you want by hand:",
				"",
				...recipe,
			].join("\n"),
			{ restore: { toRestore, recipe, refused: "too-many" } },
		);
	}
	const outcome = await reopenLostSessions(toRestore);
	const lines = [
		`Reopened ${outcome.reopened.length} of ${count(toRestore.length, "session")}.`,
	];
	if (outcome.failed.length > 0) {
		lines.push(
			"",
			"Could not reopen these; run the lines by hand:",
			...outcome.failed.map((f) => `- ${f.sessionId}: ${f.reason}`),
			...restoreRecipe(
				toRestore.filter((r) =>
					outcome.failed.some((f) => f.sessionId === r.sessionId),
				),
			),
		);
	}
	return ok(lines.join("\n"), { restore: { ...outcome, recipe } });
}

export async function recent(state: QuestState): Promise<QuestResult> {
	const { rows, total } = await recentSessions(state);
	if (rows.length === 0) {
		return ok("No recent pi sessions on any quest.", { recent: [] });
	}
	const lines = rows.map((r) => {
		const where = r.cwd ? ` ${r.cwd}` : "";
		const resume = r.cwd ? `  → pi --session ${r.sessionId}` : "";
		return `${workspaceMark(r.liveness)} ${r.questId} ${r.title ?? ""} [${r.liveness}]${where}${resume}`.trimEnd();
	});
	// Say what was cut. The cap used to trim silently, so a listing
	// that was missing the session you wanted looked exactly like a
	// listing that had everything.
	const capped =
		total > rows.length
			? ["", `Showing ${rows.length} of ${total} sessions.`]
			: [];
	return ok([...lines, ...capped].join("\n"), { recent: rows, total });
}

/** Glyph for a workspace row's liveness. */
function workspaceMark(liveness: string): string {
	switch (liveness) {
		case "live":
			return "\u25cf"; // filled circle
		case "idle":
			return "\u25cb"; // hollow circle
		case "dead":
			return "\u2717"; // ballot x
		case "conflicted":
			return "\u26a0"; // warning sign
		default:
			return "?"; // unknown
	}
}

export function ancestors(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const id = (params.id ?? state.questId ?? "").trim();
	if (!id) {
		return refuse("Load a quest first, or pass the quest `id` to trace up.");
	}
	const chain = ancestorsOf(state, id);
	if (chain === undefined) {
		return refuse(`No quest with id "${id}".`);
	}
	if (chain.length === 0) {
		return ok(`${id} is top-level; it has no ancestors.`, { ancestors: [] });
	}
	const lines = chain.map((a, i) =>
		`${"  ".repeat(i)}-> ${a.id} ${a.title ?? ""} [${a.status}]`.trimEnd(),
	);
	return ok(lines.join("\n"), { ancestors: chain });
}

export function tree(state: QuestState, _params: QuestToolParams): QuestResult {
	const { index } = discoverQuests(state.questsRoot);
	const nodes = treeAll(index);
	return renderTreeAsListing(index, nodes);
}

export function expand(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const id = params.id ?? state.questId;
	if (!id) {
		return refuse("Pass a quest id in `id` or load one first.");
	}
	const { index } = discoverQuests(state.questsRoot);
	const node = expandQuest(index, id);
	if (!node) return refuse(`No quest with id "${id}".`);
	return renderTreeAsListing(index, [node]);
}

function renderTreeAsListing(
	index: QuestIndex,
	nodes: TreeNode[],
): QuestResult {
	if (nodes.length === 0) return ok("(no quests)");
	const rows: ListingFlatRow[] = [];
	const briefLines: string[] = [];
	const visit = (node: TreeNode, depth: number): void => {
		const indent = "  ".repeat(depth);
		const brief: QuestRowBrief = {
			id: node.id,
			kind: node.kind as QuestRowBrief["kind"],
			status: node.status as QuestRowBrief["status"],
			priority: node.priority,
			title: node.title,
		};
		briefLines.push(`${indent}${renderRowBrief(brief)}`);
		const entry = index.quests.get(node.id);
		if (entry) {
			rows.push({
				...brief,
				priority: node.priority,
				parent: entry.doc.frontMatter.parent,
				updated: entry.doc.frontMatter.updated,
				depth,
				...buildRowExpansion(entry),
			});
		} else {
			// The node exists in the tree but discovery dropped
			// the entry. Surface a sparse row so the expanded
			// view still reflects every brief row.
			rows.push({
				...brief,
				priority: node.priority,
				parent: null,
				updated: "",
				depth,
			});
		}
		for (const child of node.children) visit(child, depth + 1);
	};
	for (const node of nodes) visit(node, 0);
	const listing: ListingDetails = {
		rows,
		total: rows.length,
		offset: 0,
		limit: rows.length,
		remaining: 0,
	};
	return ok(briefLines.join("\n"), { listing });
}

/** Map a document id's prefix to its storage subdir. */
export function subdirForDocumentId(id: string): string | undefined {
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
