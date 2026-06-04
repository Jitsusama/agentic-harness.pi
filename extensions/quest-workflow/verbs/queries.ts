/**
 * Read-only query verbs: tree (whole forest), expand (one
 * subtree), find (by query/date/field), who (by role/name)
 * and links (incoming/outgoing for the loaded quest). Plus
 * the subdirForDocumentId helper used by focus and other
 * lifecycle verbs to map a document id to its storage
 * subdir.
 */

import {
	buildRowExpansion,
	expandQuest,
	findPeople,
	findQuestEntries,
	getQuestEntry,
	linksForLoaded,
	type TreeNode,
	treeAll,
} from "../lookup.js";
import {
	paginate,
	type QuestRowBrief,
	renderListing,
	renderRowBrief,
	renderRowExpanded,
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
	const expanded = params.expanded === true;
	const rendered = view.rows.map(({ hit, entry }) => {
		const brief: QuestRowBrief = {
			id: hit.id,
			kind: hit.kind as QuestRowBrief["kind"],
			status: hit.status as QuestRowBrief["status"],
			title: hit.title,
		};
		if (!expanded) return renderRowBrief(brief);
		return renderRowExpanded({
			...brief,
			priority: hit.priority,
			parent: entry.doc.frontMatter.parent,
			updated: hit.updated,
			...buildRowExpansion(entry),
		});
	});
	const hits = view.rows.map((m) => m.hit);
	return ok(renderListing(rendered, view), {
		hits,
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

export function tree(state: QuestState, params: QuestToolParams): QuestResult {
	const nodes = treeAll(state);
	const message = renderTreeNodes(state, nodes, params.expanded === true);
	return ok(message, { tree: nodes });
}

export function expand(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const id = params.id ?? state.questId;
	if (!id) {
		return refuse("Pass a quest id in `id` or load one first.");
	}
	const node = expandQuest(state, id);
	if (!node) return refuse(`No quest with id "${id}".`);
	const message = renderTreeNodes(state, [node], params.expanded === true);
	return ok(message, { node });
}

function renderTreeNodes(
	state: QuestState,
	nodes: TreeNode[],
	expanded: boolean,
): string {
	if (nodes.length === 0) return "(no quests)";
	const lines: string[] = [];
	const visit = (node: TreeNode, depth: number): void => {
		const indent = "  ".repeat(depth);
		const brief: QuestRowBrief = {
			id: node.id,
			kind: node.kind as QuestRowBrief["kind"],
			status: node.status as QuestRowBrief["status"],
			title: node.title,
		};
		if (!expanded) {
			lines.push(`${indent}${renderRowBrief(brief)}`);
		} else {
			const entry = getQuestEntry(state, node.id);
			if (entry) {
				const expandedLines = renderRowExpanded({
					...brief,
					priority: node.priority,
					parent: entry.doc.frontMatter.parent,
					updated: entry.doc.frontMatter.updated,
					...buildRowExpansion(entry),
				}).split("\n");
				for (const ln of expandedLines) lines.push(`${indent}${ln}`);
			} else {
				lines.push(`${indent}${renderRowBrief(brief)}`);
			}
		}
		for (const child of node.children) visit(child, depth + 1);
	};
	for (const node of nodes) visit(node, 0);
	return lines.join("\n");
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
