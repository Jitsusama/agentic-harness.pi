/**
 * A quest's notes, carried with its session: the facts its sessions
 * remembered, which live in each machine's own memory store, so a
 * session that moves would otherwise wake without them. The quest's
 * plans, journal and scratch already go with the share; the facts are
 * all that stayed (FZ9MFJ's "A Web, Not a Funnel": a move takes the
 * cell's forage, notes and tree).
 *
 * On arrival each note the store here lacks is added, judged by its
 * quest and text, so arriving twice, or two sessions of one quest
 * arriving, adds each once.
 */

import type { MemoryStore } from "../../memory/index.ts";

/** One fact as a done file carries it. */
export interface CarriedNote {
	readonly text: string;
	readonly tags: readonly string[];
	readonly source?: string;
}

/** The quest's facts in `store`, as a done file carries them. */
export async function notesOf(
	store: MemoryStore,
	quest: string,
): Promise<CarriedNote[]> {
	const facts = await store.active({ kind: "quest", id: quest });
	return facts.map((fact) => ({
		text: fact.text,
		tags: [...fact.tags],
		...(fact.source === undefined ? {} : { source: fact.source }),
	}));
}

/**
 * Adds each of `notes` that `store` lacks for `quest`, answering how
 * many it added.
 */
export async function takeNotes(
	store: MemoryStore,
	quest: string,
	notes: readonly CarriedNote[],
): Promise<number> {
	const scope = { kind: "quest", id: quest } as const;
	const known = new Set((await store.active(scope)).map((fact) => fact.text));
	let added = 0;
	for (const note of notes) {
		if (known.has(note.text)) continue;
		await store.retain({
			scope,
			text: note.text,
			tags: note.tags,
			...(note.source === undefined ? {} : { source: note.source }),
		});
		known.add(note.text);
		added += 1;
	}
	return added;
}

/** Whether a done file's field is one note it may carry. */
export function isCarriedNote(value: unknown): value is CarriedNote {
	if (typeof value !== "object" || value === null) return false;
	const note = value as Record<string, unknown>;
	return (
		typeof note.text === "string" &&
		note.text.trim() !== "" &&
		Array.isArray(note.tags) &&
		note.tags.every((tag) => typeof tag === "string") &&
		(note.source === undefined || typeof note.source === "string")
	);
}
