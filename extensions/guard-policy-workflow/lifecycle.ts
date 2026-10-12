/**
 * Where the policy's settings come from and where they go.
 *
 * Config is read from the package config's `guards` section at session
 * start. Session overrides are saved as a custom entry each time they
 * change and restored from the branch, so a resumed session keeps them
 * and a fork from before a change does not inherit it.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	isGuardMode,
	type ModeSettings,
	parseGuardSection,
	restoreSessionModes,
	sessionModes,
	setConfiguredModes,
} from "../../lib/guardian/policy.ts";
import {
	getSection,
	loadPackageConfig,
} from "../../lib/internal/config/loader.ts";

/** The custom entry type session overrides are saved under. */
export const GUARD_MODES_ENTRY = "guard-modes";

/** The status-line key that says when overrides are in force. */
const STATUS_KEY = "guard-policy";

/** The modes a saved entry holds, or none when it is not shaped as one. */
function modesIn(data: unknown): [string, unknown][] {
	if (typeof data !== "object" || data === null || !("modes" in data)) {
		return [];
	}
	const { modes } = data;
	if (typeof modes !== "object" || modes === null) return [];
	return Object.entries(modes);
}

/**
 * The overrides in a branch's newest saved entry. Unknown modes are
 * dropped: they can only come from a hand-edited session file.
 */
export function savedModesOf(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): ModeSettings {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== GUARD_MODES_ENTRY) {
			continue;
		}
		const modes: Record<string, ModeSettings[string]> = {};
		for (const [key, mode] of modesIn(entry.data)) {
			if (isGuardMode(mode)) modes[key] = mode;
		}
		return modes;
	}
	return {};
}

/** Read the config section and the branch's overrides into the policy. */
export async function loadModes(ctx: ExtensionContext): Promise<void> {
	const loaded = await loadPackageConfig();
	if (!loaded.ok) {
		setConfiguredModes({});
		ctx.ui.notify(`Guard policy: ${loaded.error}`, "warning");
	} else {
		const section = getSection(loaded.config, "guards", parseGuardSection);
		setConfiguredModes(section.value);
		if (section.warning) {
			ctx.ui.notify(
				`Guard policy: the guards section of ${loaded.path} ${section.warning}; using defaults.`,
				"warning",
			);
		}
	}
	restoreSessionModes(savedModesOf(ctx.sessionManager.getBranch()));
	showOverrides(ctx);
}

/** Save the session's overrides and refresh the status line. */
export function saveModes(pi: ExtensionAPI, ctx: ExtensionContext): void {
	pi.appendEntry<{ modes: Record<string, string> }>(GUARD_MODES_ENTRY, {
		modes: { ...sessionModes() },
	});
	showOverrides(ctx);
}

/** Say on the status line which overrides this session holds, if any. */
function showOverrides(ctx: ExtensionContext): void {
	const modes = Object.entries(sessionModes());
	if (modes.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const theme = ctx.ui.theme;
	const said = modes.map(([key, mode]) => `${key} ${mode}`).join(", ");
	ctx.ui.setStatus(STATUS_KEY, theme.fg("muted", `guards: ${said}`));
}
