/**
 * Shared state helpers for extensions that persist and restore
 * state across sessions, and inject/filter context messages.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

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

/**
 * Returns a context handler that strips messages with the given
 * customType when the extension is inactive.
 *
 * Usage:
 *   pi.on("context", filterContext("my-context", () => enabled));
 */
export function filterContext(customType: string, isActive: () => boolean) {
	return async (event: { messages: unknown[] }) => {
		if (isActive()) return;
		return {
			messages: event.messages.filter((m) => {
				if (typeof m !== "object" || m === null) return true;
				return !("customType" in m && m.customType === customType);
			}),
		};
	};
}
