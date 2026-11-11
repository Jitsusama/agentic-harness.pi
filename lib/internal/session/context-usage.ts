/**
 * The context's usage, worked out once per leaf and model however many
 * extensions ask.
 *
 * pi answers `getContextUsage()` by rebuilding the session's projection
 * and branch from its whole history: about 60 ms on pi's main thread
 * for a session with a 24 MB log, during which it reads no key. On 10
 * November a profile of such a session found the status line, the mesh
 * and the compaction trigger each asking at the end of the same turn,
 * 1.1 s of rebuilds in ten minutes on top of pi's own. The answer
 * depends only on the entries up to the leaf and on the model's context
 * window, and every entry pi appends becomes the new leaf, so it is kept
 * for as long as the leaf and the model stay what they were. A session
 * with no entries yet has no leaf to key it by, and costs nothing to
 * read, so it is read every time.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** What pi says of the context: tokens, window and share, or nothing. */
export type ContextUsage = ReturnType<ExtensionContext["getContextUsage"]>;

/** The parts of an extension's context the usage is read from. */
export type UsageContext = Partial<
	Pick<ExtensionContext, "getContextUsage">
> & {
	readonly sessionManager?: { getLeafId(): string | null | undefined };
	readonly model?: { id: string; contextWindow?: number } | undefined;
};

interface Held {
	readonly key: string;
	readonly usage: ContextUsage;
}

/** One reading per session, by the session's manager, which pi keeps. */
const held = new WeakMap<object, Held>();

/**
 * The context's usage, read from pi only when the leaf or model moved,
 * and nothing from a context that can't say, as some stand-ins can't.
 */
export function contextUsageOf(ctx: UsageContext): ContextUsage {
	const manager = ctx.sessionManager;
	const leaf = manager?.getLeafId();
	if (!manager || !leaf) return ctx.getContextUsage?.();
	const key = `${leaf}\n${ctx.model?.id ?? ""}\n${ctx.model?.contextWindow ?? ""}`;
	const before = held.get(manager);
	if (before?.key === key) return before.usage;
	const usage = ctx.getContextUsage?.();
	held.set(manager, { key, usage });
	return usage;
}
