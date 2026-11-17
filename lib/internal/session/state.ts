/**
 * Shared helpers for extensions that need to persist state
 * across sessions and restore it on startup.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Type guard for custom entries with a specific customType. */
function isCustomEntry(
	entry: { type: string },
	customType: string,
): entry is { type: "custom"; customType: string; data: unknown } {
	return (
		entry.type === "custom" &&
		"customType" in entry &&
		(entry as { customType?: string }).customType === customType
	);
}

/**
 * Retrieve the most recently persisted entry for a given customType.
 * Returns the entry's data payload, or undefined if none exists.
 */
export function getLastEntry<T>(
	ctx: ExtensionContext,
	customType: string,
): T | undefined {
	const entries = ctx.sessionManager.getEntries();
	const last = entries.filter((e) => isCustomEntry(e, customType)).pop() as
		| { data?: T }
		| undefined;
	return last?.data;
}
