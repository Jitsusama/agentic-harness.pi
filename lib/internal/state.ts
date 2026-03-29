/**
 * Shared helpers for extensions that need to persist state
 * across sessions, restore it on startup, and manage context
 * message injection and filtering.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/** Default directory for plan files, relative to the project root. */
export const DEFAULT_PLAN_DIR = ".pi/plans";

/**
 * Load the plan directory from project settings, falling back
 * to DEFAULT_PLAN_DIR when the settings file is missing or
 * doesn't specify a custom path.
 */
export function loadPlanDir(cwd: string): string {
	try {
		const settingsPath = path.join(cwd, ".pi", "settings.json");
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		return settings.planDir ?? DEFAULT_PLAN_DIR;
	} catch {
		/* Settings file missing or malformed: use default. */
		return DEFAULT_PLAN_DIR;
	}
}

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
