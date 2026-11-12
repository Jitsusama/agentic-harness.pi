/**
 * What a system message declared or took away, tool by tool.
 *
 * pi sends a session's first tools whole (`toolsAdded`) and every later
 * change as a delta: tools added, tools taken away (`toolsRemoved`, by
 * name), sections replaced. No message restates the whole set, so the
 * set a long session holds after a reload is only known by folding
 * every message (Declared, Called, 12 November 2026). Each change
 * becomes one row with the declaration's size, never its text.
 */

import type { DeclarationRecord } from "../core/observability/index.ts";
import { isRecord } from "../internal/record.ts";

/**
 * The rows a system message gives: what it took away, then what it
 * added, at `seq`, the entry's place in its log.
 */
export function declarationsOf(
	sessionId: string,
	seq: number,
	entry: Record<string, unknown>,
	message: Record<string, unknown>,
): DeclarationRecord[] {
	const entryId = typeof entry.id === "string" ? entry.id : "";
	const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
	// One row a tool: a tool taken away and added back in one message,
	// as a changed schema is, is held at its new size.
	const rows = new Map<string, DeclarationRecord>();
	const row = (
		tool: string,
		change: DeclarationRecord["change"],
		chars: number,
	) =>
		rows.set(tool, {
			sessionId,
			entryId,
			seq,
			timestamp,
			tool,
			change,
			chars,
		});
	for (const tool of listOf(message.toolsRemoved)) {
		const name = nameOf(tool);
		if (name) row(name, "removed", 0);
	}
	for (const tool of listOf(message.toolsAdded)) {
		const name = nameOf(tool);
		if (name) row(name, "added", JSON.stringify(tool).length);
	}
	return [...rows.values()];
}

function listOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function nameOf(tool: unknown): string | undefined {
	if (!isRecord(tool)) return undefined;
	return typeof tool.name === "string" && tool.name ? tool.name : undefined;
}
