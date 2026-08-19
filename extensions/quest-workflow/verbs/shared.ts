/**
 * Shared types and helpers for the quest verb modules.
 *
 * Each verb-family module under `./` (lifecycle, stage,
 * reorder, alias, session, spawn, tree-ops, queries)
 * imports from here. transitions.ts is the dispatcher that
 * wires the action name to one of these handlers.
 *
 * QuestToolParams, QuestResult, refuse, ok and the kind sets
 * are re-exported from agentic-harness.core -- they need no
 * pi coupling at all. currentSessionId and isPersistedSession
 * stay here: both duck-type pi's own `ctx.sessionManager`,
 * which no other adapter has an equivalent for.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export {
	DOCUMENT_KINDS_SET,
	ok,
	QUEST_KINDS_SET,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "@jitsusama/agentic-harness.core/quest/verbs/shared";

/**
 * Read the current pi session id off the tool context.
 * The harness exposes a `sessionManager` with a
 * `getSessionId()` accessor; we accept a caller-supplied
 * fallback for tests and tool params that override it.
 */
export function currentSessionId(
	ctx: ExtensionContext,
	fallback: string | undefined,
): string | undefined {
	if (fallback) return fallback;
	try {
		const sm = (
			ctx as unknown as {
				sessionManager?: { getSessionId?(): string };
			}
		).sessionManager;
		return sm?.getSessionId?.();
	} catch {
		// session manager probe failed; the caller treats
		// this as "session id unavailable" and surfaces a
		// clean error.
		return undefined;
	}
}

/**
 * Whether the current pi session persists a log. False only when
 * the session manager explicitly reports an ephemeral session
 * (pi --no-session); a missing accessor defaults to true so the
 * common case still attaches and older harnesses keep working.
 */
export function isPersistedSession(ctx: ExtensionContext): boolean {
	try {
		const sm = (
			ctx as unknown as {
				sessionManager?: { isPersisted?(): boolean };
			}
		).sessionManager;
		return sm?.isPersisted?.() ?? true;
	} catch {
		// Probe failed; treat as persisted so attach behaviour is
		// unchanged when the accessor is unavailable.
		return true;
	}
}
