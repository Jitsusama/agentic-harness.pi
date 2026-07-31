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
} from "../../../lib/internal/quest/discovery.js";
import { restoreRecipe } from "../../../lib/internal/quest/session-registry.js";
import { count } from "../../../lib/ui/count.js";
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
} from "../lookup.js";
import {
	type ListingDetails,
	type ListingFlatRow,
	paginate,
	type QuestRowBrief,
	renderListing,
	renderRowBrief,
} from "../render-rows.js";
import {
	pruneClosedRecords,
	reopenLostSessions,
	restorableSessions,
	seedLiveSessions,
} from "../session-registry.js";
import type { QuestState } from "../state.js";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.js";

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
	opts: { act?: boolean } = {},
): Promise<QuestResult> {
	// Seed before asking, so tabs that were already open when the
	// registry arrived are known to be open rather than absent, and
	// prune after, so a window that has passed is not carried by every
	// later read.
	seedLiveSessions(claimedSessions(state));
	const lost = restorableSessions();
	pruneClosedRecords(state.sessionRetentionDays);
	if (lost.length === 0) {
		return ok("No sessions were lost; nothing to restore.", {
			restore: { toRestore: [], recipe: [] },
		});
	}
	const recipe = restoreRecipe(lost);
	const rows = lost.map(
		(record) =>
			`- ${record.quest ?? "(no quest)"} ${record.cwd} (session ${record.sessionId}, lost ${record.closedAt})`,
	);
	if (!opts.act) {
		const body = [
			`${count(lost.length, "session")} to restore:`,
			...rows,
			"",
			"Run to reopen them, or pass force to have restore do it:",
			...recipe,
		].join("\n");
		return ok(body, { restore: { toRestore: lost, recipe } });
	}
	if (lost.length > MAX_REOPEN_AT_ONCE) {
		// Refuse whole rather than stopping halfway. A registry that has
		// gone wrong, or a machine off for a month, should not be able
		// to turn one verb into a screenful of windows, and a partial
		// reopen would leave the user working out which half happened.
		return ok(
			[
				`${lost.length} sessions were lost, more than the ${MAX_REOPEN_AT_ONCE} restore will open at once.`,
				"Reopen the ones you want by hand:",
				"",
				...recipe,
			].join("\n"),
			{ restore: { toRestore: lost, recipe, refused: "too-many" } },
		);
	}
	const outcome = await reopenLostSessions(lost);
	const lines = [
		`Reopened ${outcome.reopened.length} of ${count(lost.length, "session")}.`,
	];
	if (outcome.failed.length > 0) {
		lines.push(
			"",
			"Could not reopen these; run the lines by hand:",
			...outcome.failed.map((f) => `- ${f.sessionId}: ${f.reason}`),
			...restoreRecipe(
				lost.filter((r) =>
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
