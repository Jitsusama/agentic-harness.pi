/**
 * Read-only query verbs: tree (whole forest), expand (one
 * subtree), find (by query/date/field), who (by role/name)
 * and links (incoming/outgoing for the loaded quest). Plus
 * the subdirForDocumentId helper used by focus and other
 * lifecycle verbs to map a document id to its storage
 * subdir.
 */

import {
	expandQuest,
	findPeople,
	findQuests,
	linksForLoaded,
	treeAll,
} from "../lookup.js";
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

export function who(state: QuestState, params: QuestToolParams): QuestResult {
	if (!params.name && !params.role) {
		return refuse("Pass `name` and/or `role` to filter Cast bullets.");
	}
	const hits = findPeople(state, { name: params.name, role: params.role });
	return ok(`${hits.length} hit(s).`, { hits });
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
	return ok(`${outgoingCount} outgoing, ${links.incoming.length} incoming.`, {
		links,
	});
}

export function tree(state: QuestState): QuestResult {
	const nodes = treeAll(state);
	return ok(`Tree with ${nodes.length} top-level quest(s).`, { tree: nodes });
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
	return ok(`Expanded ${id} with ${node.children.length} child quest(s).`, {
		node,
	});
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
