/**
 * Where the verbatim part of a compaction starts when its summary was
 * written ahead of the compaction.
 *
 * A summary written in the background covers the conversation up to
 * the point it was started at, and work carries on while it is
 * written. Whatever came after that point has to stay verbatim, since
 * the summary never saw it. Whatever pi would keep verbatim anyway
 * stays too, so a summary written ahead keeps at least the tail a
 * summary written on the spot would, and never drops what it did not
 * cover.
 *
 * The first entry after the summarised point is always a safe place to
 * start: the summary starts at a turn's end, after its tool results,
 * so what follows opens with the next reply rather than a result
 * orphaned from its call.
 */

/** The fields of a session entry the boundary reads. */
export interface BoundaryEntry {
	readonly id: string;
	readonly type: string;
}

/**
 * The first entry at or after `id` that is not a custom entry, or `id`
 * itself when only custom entries follow it.
 *
 * pi's own cut steps back over metadata to keep it with the message it
 * precedes, and the entry after a summarised point is often one an
 * extension appended at the turn's end, so either can name a custom
 * entry as the first one kept. pi resolves that fine. A host that
 * rebuilds a session from its own log and drops custom entries cannot,
 * and the compaction fails. A custom entry carries nothing into the
 * context, so starting at the next entry keeps exactly the same
 * conversation verbatim.
 */
export function pastCustomEntries(
	branch: readonly BoundaryEntry[],
	id: string,
): string {
	const at = branch.findIndex((entry) => entry.id === id);
	if (at < 0) return id;
	for (let i = at; i < branch.length; i++) {
		const entry = branch[i];
		if (entry && entry.type !== "custom") return entry.id;
	}
	return id;
}

export type KeptBoundary =
	| { ok: true; firstKeptEntryId: string }
	| { ok: false; reason: string };

/**
 * The first kept entry for a summary covering the branch up to
 * `coveredId`, given the entry pi would cut at.
 */
export function keptBoundary(
	branchIds: readonly string[],
	coveredId: string,
	cutId: string,
): KeptBoundary {
	const covered = branchIds.indexOf(coveredId);
	if (covered < 0) {
		return { ok: false, reason: "the summarised point is not on this branch" };
	}
	const cut = branchIds.indexOf(cutId);
	const afterCovered = covered + 1;
	if (afterCovered >= branchIds.length) {
		return cut >= 0
			? { ok: true, firstKeptEntryId: cutId }
			: { ok: false, reason: "nothing follows the summarised point to keep" };
	}
	const start = cut >= 0 ? Math.min(cut, afterCovered) : afterCovered;
	return { ok: true, firstKeptEntryId: branchIds[start] as string };
}
