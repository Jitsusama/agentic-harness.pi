/**
 * The quest / PR-workflow bridge.
 *
 * Quest-workflow registers a bridge object on activate;
 * pr-workflow reads it on PR load. When the bridge is
 * absent (quest-workflow not loaded), pr-workflow skips the
 * integration silently, the additive contract holds.
 *
 * The bridge surfaces only what pr-workflow needs:
 * - the questsRoot for the alias-index walk and any
 *   scaffold writes,
 * - the loaded quest id (so a new sidequest gets parented
 *   under the user's top-level quest),
 * - a hook to log a Journey bullet against an arbitrary
 *   quest directory (so review rounds leave footprints
 *   even when the sidequest is not the loaded quest).
 *
 * Process-global, matches the refs / url-fetchers /
 * people-resolvers registry pattern.
 */

const BRIDGE_KEY = Symbol.for("pi:quest-pr-bridge");

/** Bridge surface read by pr-workflow. */
export interface QuestPrBridge {
	/** The questsRoot directory in effect for this session. */
	questsRoot(): string;
	/** The loaded quest's id, or `null` when none is loaded. */
	loadedQuestId(): string | null;
	/**
	 * Append a Journey bullet to the quest at `questDir`.
	 * Used by pr-workflow to log review rounds against the
	 * sidequest even when it's not the loaded quest.
	 */
	logJourney(questDir: string, prose: string): void;
}

type GlobalSlot = Record<symbol, QuestPrBridge | undefined>;

/** Register the bridge. Overwrites any prior registration. */
export function registerQuestPrBridge(bridge: QuestPrBridge): void {
	(globalThis as GlobalSlot)[BRIDGE_KEY] = bridge;
}

/** Remove the bridge. Idempotent. */
export function unregisterQuestPrBridge(): void {
	(globalThis as GlobalSlot)[BRIDGE_KEY] = undefined;
}

/** Current bridge, or `undefined` when none is registered. */
export function getQuestPrBridge(): QuestPrBridge | undefined {
	return (globalThis as GlobalSlot)[BRIDGE_KEY];
}
