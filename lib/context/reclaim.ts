/**
 * What a demotion policy could reclaim from resident context, without
 * ever rewriting it.
 *
 * bash is the tool this exists for: it has no size tail at all, thirty
 * thousand small results each paying rent for the rest of a
 * seven-hundred-turn session, so a ceiling on any one result cannot
 * touch it. The only lever left is deciding, per call, which already
 * resident results still earn their rent.
 *
 * This module only measures. Chronological order is never disturbed:
 * reordering resident messages, even to group what a policy would
 * drop, breaks the provider's own prompt cache, which costs more than
 * the reclaim was worth.
 */

/** The minimum shape a message needs to be considered. */
export interface ToolResultLike {
	readonly role: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly content?: readonly unknown[];
}

export interface ReclaimCandidate {
	/** Position in the original message array. */
	readonly index: number;
	readonly toolCallId: string;
	readonly toolName: string;
	/** Approximate size of the result's content, in characters. */
	readonly chars: number;
}

export interface ReclaimAnalysis {
	/** In original chronological order, never reordered. */
	readonly candidates: ReclaimCandidate[];
	readonly totalChars: number;
}

export interface FindReclaimableOptions {
	/**
	 * How many of the most recent tool results, of any tool, are never
	 * a candidate. This is the active working set: results the next few
	 * turns are still likely to reference directly.
	 */
	readonly keepRecent: number;
	/** Which tools are eligible. Defaults to bash alone. */
	readonly tools?: readonly string[];
}

const DEFAULT_TOOLS: readonly string[] = ["bash"];

/** Characters in a result's text content, counting every text block. */
function charsOf(content: readonly unknown[] | undefined): number {
	if (!content) return 0;
	let total = 0;
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"text" in block &&
			typeof (block as { text: unknown }).text === "string"
		) {
			total += (block as { text: string }).text.length;
		}
	}
	return total;
}

/**
 * Which already-resident tool results a demotion policy could reclaim:
 * every eligible result outside the kept recent window.
 */
export function findReclaimable(
	messages: readonly ToolResultLike[],
	options: FindReclaimableOptions,
): ReclaimAnalysis {
	const tools = new Set(options.tools ?? DEFAULT_TOOLS);

	// Recency is counted over every tool result, not just eligible ones,
	// since a recent read or edit result is still part of the active
	// working set even though it is never itself a candidate.
	const resultIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "toolResult") resultIndices.push(i);
	}
	const keptIndices = new Set(
		resultIndices.slice(Math.max(0, resultIndices.length - options.keepRecent)),
	);

	const candidates: ReclaimCandidate[] = [];
	let totalChars = 0;
	for (const i of resultIndices) {
		if (keptIndices.has(i)) continue;
		const message = messages[i];
		if (!message.toolName || !tools.has(message.toolName)) continue;
		const chars = charsOf(message.content);
		candidates.push({
			index: i,
			toolCallId: message.toolCallId ?? "",
			toolName: message.toolName,
			chars,
		});
		totalChars += chars;
	}

	return { candidates, totalChars };
}
