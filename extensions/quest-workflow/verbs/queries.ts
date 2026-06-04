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
import {
	buildRowExpansion,
	expandQuest,
	findPeople,
	findQuestEntries,
	linksForLoaded,
	type TreeNode,
	treeAll,
} from "../lookup.js";
import {
	type ListingDetails,
	type ListingFlatRow,
	paginate,
	type QuestRowBrief,
	renderListing,
	renderRowBrief,
} from "../render-rows.js";
import type { QuestState } from "../state.js";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.js";

export function find(state: QuestState, params: QuestToolParams): QuestResult {
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
	const matches = findQuestEntries(state, {
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
		`Outgoing (${outgoingCount}): ${links.outgoing.quests.length} quest(s), ${links.outgoing.refs.length} ref(s), ${links.outgoing.urls.length} url(s).`,
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
	return ok(briefLines.join("\n"), { listing, tree: nodes });
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
