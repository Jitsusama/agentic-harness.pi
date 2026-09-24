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

/** The summariser recorded on compactions written from the conversation. */
const CONVERSATION_SUMMARISER = "conversation";

/** Recent turns averaged for what a turn costs beyond its reads. */
const OVERHEAD_WINDOW = 50;

export interface CompactionHistory {
	/** Assistant turns since the last compaction, or since the start. */
	readonly turnsSinceCompaction: number;
	/** Prompt of every turn since the last compaction, oldest first. */
	readonly promptsSinceCompaction: readonly number[];
	/** Cache write of the first turn after the last compaction, if any. */
	readonly rewriteTokens: number | null;
	/**
	 * Output of the last compaction written from the conversation,
	 * thinking included, if the latest one was.
	 */
	readonly summaryOutputTokens: number | null;
	/**
	 * What recent turns cost beyond reading their context, in dollars:
	 * output and new writes, which a turn pays whatever the context size.
	 */
	readonly turnOverhead: number | null;
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

/** Output tokens of a compaction the conversation summariser wrote. */
function conversationSummaryOutput(
	entry: Record<string, unknown>,
): number | null {
	const details = isRecord(entry.details) ? entry.details : {};
	if (details.summariser !== CONVERSATION_SUMMARISER) return null;
	return isRecord(entry.usage) ? count(entry.usage.output) : null;
}

/** What a turn cost beyond its cache reads, or null when it says nothing. */
function overheadOf(entry: Record<string, unknown>): number | null {
	if (!isRecord(entry.message) || !isRecord(entry.message.usage)) return null;
	const { cost } = entry.message.usage;
	if (!isRecord(cost) || typeof cost.total !== "number") return null;
	return Math.max(0, cost.total - count(cost.cacheRead));
}

/** Read turns, retained sizes and costs out of a session branch's entries. */
export function compactionHistory(
	entries: readonly unknown[],
): CompactionHistory {
	let prompts: number[] = [];
	let retainedTokens: number | null = null;
	let rewriteTokens: number | null = null;
	let summaryOutputTokens: number | null = null;
	let firstPromptTokens: number | null = null;
	let awaitingRetained = false;
	const overheads: number[] = [];

	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (entry.type === "compaction") {
			prompts = [];
			awaitingRetained = true;
			summaryOutputTokens = conversationSummaryOutput(entry);
			continue;
		}
		const prompt = promptOf(entry);
		if (prompt === null) continue;
		prompts.push(prompt);
		const overhead = overheadOf(entry);
		if (overhead !== null) overheads.push(overhead);
		if (firstPromptTokens === null) firstPromptTokens = prompt;
		if (awaitingRetained) {
			retainedTokens = prompt;
			rewriteTokens =
				isRecord(entry.message) && isRecord(entry.message.usage)
					? count(entry.message.usage.cacheWrite)
					: null;
			awaitingRetained = false;
		}
	}

	const recent = overheads.slice(-OVERHEAD_WINDOW);
	return {
		turnsSinceCompaction: prompts.length,
		promptsSinceCompaction: prompts,
		retainedTokens,
		rewriteTokens,
		summaryOutputTokens,
		firstPromptTokens,
		turnOverhead: recent.length
			? recent.reduce((a, b) => a + b, 0) / recent.length
			: null,
	};
}
