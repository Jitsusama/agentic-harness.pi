import { paybackMargin } from "../compaction/index.js";

/**
 * Deciding when a batch of resident tool results is worth demoting.
 *
 * The provider's prompt cache is a prefix cache: changing one message
 * re-writes everything after it at the cache-write price, which with
 * one-hour retention is twenty times a cache read. Demoting each result
 * the moment it leaves a recent window therefore re-writes a suffix on
 * every turn, and a replay of a month of real sessions put that policy
 * at $10,242 a month worse than doing nothing.
 *
 * So demotion goes in batches. A batch is every eligible result outside
 * the kept window that is not demoted yet, and it fires only when the
 * payback test says so: the reads it saves on the turns still to come
 * outweigh re-writing the suffix after its first result once. That is
 * compaction's own test, because demotion is compaction that keeps its
 * bytes. Between batches the demoted set is frozen, so the prompt stays
 * byte-identical and the cache holds.
 *
 * Sizes are in characters, and no characters-per-token estimate is
 * needed: removed and re-written characters scale by the same ratio, so
 * it cancels out of the decision.
 */

/** One message's identity and the characters it puts in the prompt. */
export interface SizedMessage {
	readonly role: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly chars: number;
}

export interface BatchInput {
	/** The prompt about to be sent, in order, before any demotion. */
	readonly messages: readonly SizedMessage[];
	/** Tool calls already demoted in this session, and frozen as stubs. */
	readonly demoted: ReadonlySet<string>;
	/** Most recent tool results, of any tool, never demoted. */
	readonly keepRecent: number;
	/**
	 * Turns so far, standing in for the turns still to come. Absent any
	 * better knowledge, a session is as likely to be past its midpoint as
	 * before it, so as many again is the honest estimate.
	 */
	readonly turnsElapsed: number;
	readonly readPrice: number;
	readonly writePrice: number;
	/** Characters a stub leaves in a demoted result's place. */
	readonly stubChars: number;
	/** Tools eligible for demotion. Defaults to bash alone. */
	readonly tools?: readonly string[];
}

export interface BatchDecision {
	readonly fire: boolean;
	/** Tool call ids the batch would demote, in prompt order. */
	readonly candidates: readonly string[];
	/** Characters the batch removes, net of the stubs it leaves. */
	readonly droppedChars: number;
	/** Characters after the batch's first result that would be re-written. */
	readonly suffixChars: number;
	/** Saved over cost, as compaction's payback test reads it. */
	readonly margin: number;
}

const DEFAULT_TOOLS: readonly string[] = ["bash"];

const NOTHING: BatchDecision = {
	fire: false,
	candidates: [],
	droppedChars: 0,
	suffixChars: 0,
	margin: 0,
};

/** Decide whether demoting the next batch pays for its own cache rewrite. */
export function planBatch(input: BatchInput): BatchDecision {
	const tools = new Set(input.tools ?? DEFAULT_TOOLS);
	const { messages, demoted, stubChars } = input;

	const resultIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "toolResult") resultIndices.push(i);
	}
	const kept = new Set(
		resultIndices.slice(Math.max(0, resultIndices.length - input.keepRecent)),
	);

	const chosen: { index: number; id: string }[] = [];
	for (const i of resultIndices) {
		const message = messages[i];
		if (kept.has(i)) continue;
		if (!message.toolCallId || demoted.has(message.toolCallId)) continue;
		if (!message.toolName || !tools.has(message.toolName)) continue;
		// A result no bigger than its stub would grow by being demoted.
		if (message.chars <= stubChars) continue;
		chosen.push({ index: i, id: message.toolCallId });
	}
	if (chosen.length === 0) return NOTHING;

	const batch = new Set(chosen.map((c) => c.index));
	let droppedChars = 0;
	for (const c of chosen) droppedChars += messages[c.index].chars - stubChars;

	// Everything from the batch's first result onward is re-written, as it
	// would be sent: a stub wherever a result is demoted, old or new.
	let suffixChars = 0;
	for (let i = chosen[0].index; i < messages.length; i++) {
		const message = messages[i];
		const stubbed =
			batch.has(i) ||
			(message.toolCallId !== undefined && demoted.has(message.toolCallId));
		suffixChars += stubbed ? stubChars : message.chars;
	}

	const margin = paybackMargin({
		droppedTokens: droppedChars,
		remainingTurns: input.turnsElapsed,
		retainedTokens: suffixChars,
		readPrice: input.readPrice,
		writePrice: input.writePrice,
	});

	return {
		fire: margin > 1,
		candidates: chosen.map((c) => c.id),
		droppedChars,
		suffixChars,
		margin,
	};
}
