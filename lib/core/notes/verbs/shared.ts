/**
 * Shared types and helpers for the notes verb modules.
 *
 * Unlike quest, notes has no persisted cross-invocation
 * state (no "loaded note", nothing to remember between CLI
 * calls) -- every verb is self-contained given a
 * `notesRoot` and its params. See `bin/notes.ts` for the
 * CLI wiring this implies.
 */

import type { NoteType } from "../types.ts";

export interface NoteToolParams {
	id?: string;
	type?: string;
	title?: string;
	tags?: string;
	add?: string;
	remove?: string;
	parent?: string;
	created?: string;
	q?: string;
	since?: string;
	until?: string;
	limit?: number;
}

export type NoteResult =
	| { ok: true; message: string; details?: Record<string, unknown> }
	| { ok: false; guidance: string };

/** The shared mark for no, reused from quest for the same reason: one mark for no across every surface. */
const REFUSED = "⊘";

/** Build a structured refusal result. */
export function refuse(guidance: string): NoteResult {
	return { ok: false, guidance: `${REFUSED} ${guidance}` };
}

/** Build a structured success result. */
export function ok(
	message: string,
	details?: Record<string, unknown>,
): NoteResult {
	return { ok: true, message, details };
}

export function isNoteType(value: string): value is NoteType {
	return (
		value === "journal" ||
		value === "reference" ||
		value === "faith" ||
		value === "financial" ||
		value === "gaming" ||
		value === "travel" ||
		value === "writing" ||
		value === "inbox"
	);
}
