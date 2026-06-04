/**
 * Reverse-mention index: for each quest in the index, find
 * every other quest whose body or documents mention it.
 *
 * Two kinds of mentions:
 *
 * - Bare IDs in prose: `QEST-...`, `PLAN-...`, etc.
 * - Refs: anything the registered ref types extract.
 *
 * For Echoes rendering on `quest show`, we care about
 * inbound mentions: "who has mentioned QEST-X". The reverse
 * map is keyed by the target id (or ref canonical) and
 * values are the source quests.
 */

import type { QuestIndex } from "./discovery.js";
import type { IdMentionRelation } from "./id.js";
import { extractMentions } from "./quest-doc.js";

/** One inbound mention. */
export interface MentionEdge {
	/** The quest the mention came from. */
	from: string;
	/** Short snippet of context around the mention. */
	snippet: string;
	/**
	 * How the source document referred to this id. `produced`
	 * when the mention was preceded by the → sigil; a bare
	 * reference otherwise. Refs carry `reference` since the
	 * sigil applies to ids only.
	 */
	relation: IdMentionRelation;
}

/** Snapshot of mentions for the whole index. */
export interface MentionIndex {
	/** Inbound mentions keyed by target quest/document id. */
	byId: Map<string, MentionEdge[]>;
	/** Inbound mentions keyed by `${type}:${value}` for refs. */
	byRef: Map<string, MentionEdge[]>;
}

const SNIPPET_RADIUS = 80;

function findSnippet(body: string, needle: string): string {
	const idx = body.indexOf(needle);
	if (idx < 0) return "";
	const start = Math.max(0, idx - SNIPPET_RADIUS);
	const end = Math.min(body.length, idx + needle.length + SNIPPET_RADIUS);
	const raw = body.slice(start, end).replace(/\s+/g, " ").trim();
	const prefix = start > 0 ? "..." : "";
	const suffix = end < body.length ? "..." : "";
	return `${prefix}${raw}${suffix}`;
}

/**
 * Build a reverse-mention index over every quest in the
 * input. Each quest contributes both its README body and
 * its documents' bodies to the mention pool.
 */
export function buildMentionIndex(index: QuestIndex): MentionIndex {
	const byId = new Map<string, MentionEdge[]>();
	const byRef = new Map<string, MentionEdge[]>();

	const push = (
		map: Map<string, MentionEdge[]>,
		key: string,
		edge: MentionEdge,
	) => {
		const list = map.get(key) ?? [];
		list.push(edge);
		map.set(key, list);
	};

	for (const [questId, entry] of index.quests) {
		const bodies: string[] = [entry.doc.body];
		for (const docEntry of entry.documents) bodies.push(docEntry.doc.body);
		const combined = bodies.join("\n\n");
		const mentions = extractMentions(combined);

		for (const idMention of mentions.idMentions) {
			if (idMention.id === questId) continue;
			push(byId, idMention.id, {
				from: questId,
				snippet: findSnippet(combined, idMention.id),
				relation: idMention.relation,
			});
		}
		for (const ref of mentions.refs) {
			const key = `${ref.type}:${ref.value}`;
			push(byRef, key, {
				from: questId,
				snippet: findSnippet(combined, ref.value),
				relation: "reference",
			});
		}
	}

	return { byId, byRef };
}

/** Convenience: lookup inbound mentions for one target quest id. */
export function mentionsOf(
	index: MentionIndex,
	targetId: string,
): MentionEdge[] {
	return index.byId.get(targetId) ?? [];
}
