/**
 * Read-only query verbs: tree (whole forest), expand (one
 * subtree), find (by query/date/field), who (by role/name),
 * links (incoming/outgoing) and locate (resolve a needle to
 * its owning quest). Plus the subdirForDocumentId helper used
 * to map a document id to its storage subdir.
 *
 * pi's own `verbs/queries.ts` additionally exposes `workspace`,
 * `restore` and `recent`, all keyed to pi's session JSONL log
 * and terminal-reopen mechanism. Neither has an equivalent here;
 * an adapter with its own session store builds those on top of
 * `discoverQuests` directly, the way pi's does.
 */

import { count } from "../../../ui/count.ts";
import {
	discoverQuests,
	type QuestIndex,
} from "../../internal/quest/discovery.ts";
import {
	ancestorsOf,
	buildRowExpansion,
	expandQuest,
	findPeople,
	findQuestEntries,
	linksForLoaded,
	locateOwner,
	resolveRefQuery,
	type TreeNode,
	treeAll,
} from "../lookup.ts";
import {
	type ListingDetails,
	type ListingFlatRow,
	paginate,
	type QuestRowBrief,
	renderListing,
	renderRowBrief,
} from "../render-rows.ts";
import type { QuestState } from "../state.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

export function find(state: QuestState, params: QuestToolParams): QuestResult {
	const ALLOWED_FIELDS = ["started", "updated", "due", "eta"];
	if (params.field && !ALLOWED_FIELDS.includes(params.field)) {
		return refuse(
			`Unknown field "${params.field}". Use started, updated, due or eta.`,
		);
	}
	const field = params.field as
		| "started"
		| "updated"
		| "due"
		| "eta"
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
			"Pass the thing to locate in `id` (or `query`): a quest id, document id or alias ref.",
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
