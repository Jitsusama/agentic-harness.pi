/**
 * A durable journal of applied structural edits (reparents and
 * bulk status changes). Each entry records the old and new value
 * per quest so an operation can be reversed. The journal is a
 * JSONL file at the quests root; the most recent line is the
 * newest operation.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One quest's before-and-after for a single field. */
export interface JournalChange {
	id: string;
	field: "parent" | "status";
	old: string | null;
	new: string | null;
}

/** A recorded structural operation. */
export interface JournalEntry {
	ts: string;
	op: string;
	changes: JournalChange[];
}

function journalPath(questsRoot: string): string {
	return join(questsRoot, ".structural-journal.jsonl");
}

/** Append an applied operation to the journal. */
export function recordStructuralOp(
	questsRoot: string,
	op: string,
	changes: JournalChange[],
): void {
	const entry: JournalEntry = { ts: new Date().toISOString(), op, changes };
	appendFileSync(journalPath(questsRoot), `${JSON.stringify(entry)}\n`, "utf8");
}

function readEntries(questsRoot: string): JournalEntry[] {
	let text: string;
	try {
		text = readFileSync(journalPath(questsRoot), "utf8");
	} catch {
		// No journal yet: nothing has been recorded.
		return [];
	}
	const entries: JournalEntry[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed) as JournalEntry);
		} catch {
			// Skip a corrupt line rather than wedging undo.
		}
	}
	return entries;
}

/** The most recent recorded operation, or undefined when empty. */
export function lastStructuralOp(questsRoot: string): JournalEntry | undefined {
	const entries = readEntries(questsRoot);
	return entries[entries.length - 1];
}

/** Remove the most recent recorded operation. */
export function dropLastStructuralOp(questsRoot: string): void {
	const entries = readEntries(questsRoot);
	if (entries.length === 0) return;
	entries.pop();
	const body = entries.map((e) => JSON.stringify(e)).join("\n");
	writeFileSync(
		journalPath(questsRoot),
		body.length > 0 ? `${body}\n` : "",
		"utf8",
	);
}
