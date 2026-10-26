/**
 * A durable journal of applied structural edits (reparents and
 * bulk status changes). Each entry records the old and new value
 * per quest so an operation can be reversed. The journal is a
 * JSONL file at the quests root; the most recent line is the
 * newest operation.
 *
 * Every session on the machine writes to the one journal, so each
 * entry says which session wrote it and carries an id of its own. On
 * 25 October an undo meant for one session's section write reversed
 * another session's day-old conclude, twice, because undo took the
 * newest entry whoever wrote it. Undo now takes only its own session's
 * newest entry, and an entry written before entries carried a session
 * is nobody's to undo.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processGlobal } from "../process-global.ts";
import { atomicWriteFile, withQuestLock } from "./io.ts";

/**
 * A field a mutation can change, journal and reverse. Widened past
 * the original parent-and-status pair so every quest field mutation
 * is reversible; `stage` covers document mutations journalled the
 * same way.
 */
export type MutableField =
	| "parent"
	| "status"
	| "priority"
	| "rank"
	| "kind"
	| "stage";

/** One quest's before-and-after for a single field. */
export interface JournalChange {
	id: string;
	field: MutableField;
	old: string | null;
	new: string | null;
}

/** A recorded structural operation. */
export interface JournalEntry {
	ts: string;
	op: string;
	changes: JournalChange[];
	/** This entry's own id, so it can be dropped without touching others. */
	entry?: string;
	/** The session that made the change, when one was known. */
	session?: string;
}

function journalPath(questsRoot: string): string {
	return join(questsRoot, ".structural-journal.jsonl");
}

// Which session this process's journal writes belong to. Process-wide
// because journal writes come from many verbs and from the README
// writer under them, all in the one session the process runs; the
// quest workflow says which as the session starts and on every call.
const author = processGlobal<{ session?: string }>(
	"agentic-harness:quest-journal-author",
	() => ({}),
);

/** Say which session this process's journal writes belong to. */
export function setJournalSession(session: string | undefined): void {
	author.session = session;
}

/** The session this process's journal writes belong to, when known. */
export function journalSession(): string | undefined {
	return author.session;
}

/**
 * Append an applied operation to the journal, under the same
 * per-root advisory lock the README writers use, so a concurrent
 * record and undo in another process cannot interleave.
 */
export function recordStructuralOp(
	questsRoot: string,
	op: string,
	changes: JournalChange[],
): void {
	const entry: JournalEntry = {
		ts: new Date().toISOString(),
		op,
		changes,
		entry: randomUUID(),
		...(author.session ? { session: author.session } : {}),
	};
	withQuestLock(questsRoot, () => {
		appendFileSync(
			journalPath(questsRoot),
			`${JSON.stringify(entry)}\n`,
			"utf8",
		);
	});
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

/** The newest operation this session recorded, or undefined. */
export function ownNewestStructuralOp(
	questsRoot: string,
	session: string,
): JournalEntry | undefined {
	const entries = readEntries(questsRoot);
	for (let at = entries.length - 1; at >= 0; at--) {
		const entry = entries[at];
		if (entry?.session === session && entry.entry) return entry;
	}
	return undefined;
}

/**
 * The operations recorded after `entry` that touched one of its
 * quests: another session's, since `entry` is its own session's
 * newest. Reverting `entry` would undo what they built on.
 */
export function changedSince(
	questsRoot: string,
	entry: JournalEntry,
): JournalEntry[] {
	const entries = readEntries(questsRoot);
	const at = entries.findIndex((one) => one.entry === entry.entry);
	if (at < 0) return [];
	const quests = new Set(entry.changes.map((change) => change.id));
	return entries
		.slice(at + 1)
		.filter((later) => later.changes.some((change) => quests.has(change.id)));
}

/**
 * Drop the operation with this id, keeping `residue` in its place
 * when undo could not apply all of it, so a later undo can finish.
 * Read, change and rewrite run under the per-root lock, through an
 * atomic rename, so a concurrent append is never lost and no other
 * session's entry moves.
 */
export function dropStructuralOp(
	questsRoot: string,
	entryId: string,
	residue: readonly JournalChange[] = [],
): void {
	withQuestLock(questsRoot, () => {
		const entries = readEntries(questsRoot).flatMap((one) => {
			if (one.entry !== entryId) return [one];
			return residue.length > 0 ? [{ ...one, changes: [...residue] }] : [];
		});
		const body = entries.map((e) => JSON.stringify(e)).join("\n");
		atomicWriteFile(
			journalPath(questsRoot),
			body.length > 0 ? `${body}\n` : "",
		);
	});
}
