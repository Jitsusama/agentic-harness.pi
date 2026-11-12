/**
 * The context's usage, worked out from pi once and then followed from
 * the entries it appends, however many extensions ask.
 *
 * pi answers `getContextUsage()` by rebuilding the session's projection
 * and branch from its whole history: about 60 ms on pi's main thread
 * for a session with a 24 MB log, during which it reads no key. On 10
 * November a profile of such a session found the status line, the mesh
 * and the compaction trigger each asking at the end of the same turn,
 * so the answer was kept for as long as the leaf and the model stayed
 * what they were. But every entry pi appends is a new leaf, and on 12
 * November a profile of a 38 MB session found those rebuilds still the
 * harness's costliest work on pi's main thread, 0.65 s of each minute
 * of a turn, in bursts of 10 to 100 ms.
 *
 * So once read, the figure is carried forward the way pi works it out:
 * an answer from the model with usage gives the context's size, and
 * anything after it adds its estimate. Only the entries appended since
 * the last reading are looked at. pi is asked again whenever that
 * can't be followed: an entry that rewrites the context (a compaction,
 * a branch summary, an edit, a new system message), a leaf that moved
 * anywhere but forward, a new model, or a stand-in that can't say.
 * pi 1.5 estimates a trailing message with pi-ai's estimator rather
 * than the one pi exports here; the two differ by a few tokens on a
 * tool call, and only until the next answer.
 */

import {
	calculateContextTokens,
	type ExtensionContext,
	estimateTokens,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

/** A message as pi gives it to the model. */
type ContextMessage = ReturnType<typeof sessionEntryToContextMessages>[number];

/** What pi says of the context: tokens, window and share, or nothing. */
export type ContextUsage = ReturnType<ExtensionContext["getContextUsage"]>;

/** The parts of an extension's context the usage is read from. */
export type UsageContext = Partial<
	Pick<ExtensionContext, "getContextUsage">
> & {
	readonly sessionManager?: {
		getLeafId(): string | null | undefined;
		getEntry?(id: string): SessionEntry | undefined;
	};
	readonly model?: { id: string; contextWindow?: number } | undefined;
};

interface Held {
	readonly leaf: string;
	readonly model: string;
	readonly usage: ContextUsage;
}

/** One reading per session, by the session's manager, which pi keeps. */
const held = new WeakMap<object, Held>();

/**
 * How far back a new leaf is followed to the last reading's. A turn
 * appends a few entries between asks; farther than this, pi is asked.
 */
const MOST_ENTRIES_FOLLOWED = 64;

/** Entries that hold no message for the model, or one that just adds on. */
const FOLLOWED_ENTRIES: ReadonlySet<string> = new Set([
	"message",
	"custom_message",
	"custom",
	"label",
	"session_info",
	"model_change",
	"thinking_level_change",
]);

/**
 * The context's usage, read from pi only when it can't be followed from
 * the entries appended since, and nothing from a context that can't say,
 * as some stand-ins can't.
 */
export function contextUsageOf(ctx: UsageContext): ContextUsage {
	const manager = ctx.sessionManager;
	const leaf = manager?.getLeafId();
	if (!manager || !leaf) return ctx.getContextUsage?.();
	const model = `${ctx.model?.id ?? ""}\n${ctx.model?.contextWindow ?? ""}`;
	const before = held.get(manager);
	if (before?.model === model) {
		if (before.leaf === leaf) return before.usage;
		const carried = followed(manager, before, leaf);
		if (carried !== undefined) {
			held.set(manager, { leaf, model, usage: carried });
			return carried;
		}
	}
	const usage = ctx.getContextUsage?.();
	held.set(manager, { leaf, model, usage });
	return usage;
}

/**
 * The usage carried from the last reading through the entries appended
 * since, or nothing when they can't be followed and pi must be asked.
 */
function followed(
	manager: NonNullable<UsageContext["sessionManager"]>,
	before: Held,
	leaf: string,
): ContextUsage | undefined {
	if (!before.usage || !manager.getEntry) return undefined;
	const appended = entriesSince(manager.getEntry.bind(manager), before, leaf);
	if (!appended) return undefined;
	let tokens = before.usage.tokens;
	for (const entry of appended) {
		if (!FOLLOWED_ENTRIES.has(entry.type)) return undefined;
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role === "system") return undefined;
			const answered = usageOf(message);
			if (answered !== undefined) tokens = answered;
			else if (tokens !== null) tokens += estimateTokens(message);
		}
	}
	const { contextWindow } = before.usage;
	return {
		tokens,
		contextWindow,
		percent: tokens === null ? null : (tokens / contextWindow) * 100,
	};
}

/**
 * The entries from just after the last reading's leaf to `leaf`, oldest
 * first, or nothing when `leaf` doesn't sit a few entries below it.
 */
function entriesSince(
	entry: (id: string) => SessionEntry | undefined,
	before: Held,
	leaf: string,
): SessionEntry[] | undefined {
	const appended: SessionEntry[] = [];
	let id: string | null = leaf;
	while (id !== null && appended.length < MOST_ENTRIES_FOLLOWED) {
		if (id === before.leaf) return appended.reverse();
		const found = entry(id);
		if (!found) return undefined;
		appended.push(found);
		id = found.parentId;
	}
	return undefined;
}

/**
 * The context's size as an answer from the model reports it, or nothing
 * for any other message and for an answer pi doesn't count: one cut off,
 * failed, or with no usage.
 */
function usageOf(message: ContextMessage): number | undefined {
	if (message.role !== "assistant") return undefined;
	if (message.stopReason === "aborted" || message.stopReason === "error")
		return undefined;
	// A log pi read without checking can hold an answer with no usage.
	if (!message.usage) return undefined;
	const tokens = calculateContextTokens(message.usage);
	return tokens > 0 ? tokens : undefined;
}
