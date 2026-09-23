/**
 * What a session's own log says about its compactions, so the trigger
 * starts from the session's history rather than from whatever this
 * process happened to see since it started.
 *
 * Reading it from the log matters because most long sessions are
 * resumed. A process that starts partway through a session sees the
 * whole resumed context as its first prompt; treating that as the fixed
 * overhead made nothing look droppable, so a resumed session never
 * compacted early, and counting turns from the restart made every
 * resumed session look brand new.
 */

export interface CompactionHistory {
	/** Assistant turns since the last compaction, or since the start. */
	readonly turnsSinceCompaction: number;
	/** Prompt of the first turn after the last compaction, if any. */
	readonly retainedTokens: number | null;
	/** Prompt of the session's first turn: its fixed overhead. */
	readonly firstPromptTokens: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function count(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

/** Prompt tokens an assistant entry's usage reports, or null for none. */
function promptOf(entry: Record<string, unknown>): number | null {
	if (!isRecord(entry.message)) return null;
	const { role, usage } = entry.message;
	if (role !== "assistant" || !isRecord(usage)) return null;
	return count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
}

/** Read turns and retained sizes out of a session branch's entries. */
export function compactionHistory(
	entries: readonly unknown[],
): CompactionHistory {
	let turnsSinceCompaction = 0;
	let retainedTokens: number | null = null;
	let firstPromptTokens: number | null = null;
	let awaitingRetained = false;

	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (entry.type === "compaction") {
			turnsSinceCompaction = 0;
			awaitingRetained = true;
			continue;
		}
		const prompt = promptOf(entry);
		if (prompt === null) continue;
		turnsSinceCompaction += 1;
		if (firstPromptTokens === null) firstPromptTokens = prompt;
		if (awaitingRetained) {
			retainedTokens = prompt;
			awaitingRetained = false;
		}
	}

	return { turnsSinceCompaction, retainedTokens, firstPromptTokens };
}
