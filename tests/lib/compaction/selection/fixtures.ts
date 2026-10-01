import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SELECTION_HOLDS_ENTRY } from "../../../../lib/compaction/selection/holds.ts";
import type { SelectionKind } from "../../../../lib/compaction/selection/kinds.ts";
import { SELECTION_TAGS_ENTRY } from "../../../../lib/compaction/selection/tags.ts";
import { unitsOf } from "../../../../lib/compaction/selection/units.ts";

/** A user message entry. */
export function user(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-30T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
	} as SessionEntry;
}

/** An assistant message entry, with a thinking block and a tool call beside the text. */
export function assistant(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-30T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning that is long enough" },
				{ type: "text", text },
				{ type: "toolCall", id: "t", name: "bash", arguments: {} },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {},
			stopReason: "toolUse",
			timestamp: 0,
		},
	} as SessionEntry;
}

/** A compaction entry. */
export function compaction(id: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: "2026-09-30T00:00:00.000Z",
		summary: "s",
		firstKeptEntryId: "x",
		tokensBefore: 1,
	} as SessionEntry;
}

/** The tags entry for a message, each paragraph given the kinds listed in order. */
export function tagged(
	message: SessionEntry,
	...kinds: SelectionKind[][]
): SessionEntry {
	return {
		type: "custom",
		id: `tags-${message.id}`,
		parentId: null,
		timestamp: "2026-09-30T00:00:00.000Z",
		customType: SELECTION_TAGS_ENTRY,
		data: {
			entryId: message.id,
			units: unitsOf(message).map((unit, at) => ({
				hash: unit.hash,
				kinds: kinds[at] ?? [],
			})),
		},
	} as SessionEntry;
}

/** A judgements entry. */
export function judged(
	id: string,
	holds: Record<string, number>,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-09-30T00:00:00.000Z",
		customType: SELECTION_HOLDS_ENTRY,
		data: { holds },
	} as SessionEntry;
}
