/**
 * Panel Zoom Widget Extension
 *
 * Registers global input handlers to toggle panel height between
 * minimized, normal, and fullscreen modes. Uses onTerminalInput
 * so the shortcuts work even while a panel has focus.
 *
 * The status-line extension reads the current mode glyph from the
 * shared panel-height module and renders it as a pinned far-right
 * system indicator.
 *
 * - Ctrl+Alt+F: toggle fullscreen (normal ↔ fullscreen)
 * - Ctrl+Alt+M: toggle minimized (normal ↔ minimized)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@mariozechner/pi-tui";
import {
	getPanelHeightMode,
	setPanelHeightMode,
} from "../lib/ui/panel-height.js";
import type { PanelHeightMode } from "../lib/ui/types.js";

/** Toggle to a mode, returning to normal if already active. */
function toggle(target: PanelHeightMode): void {
	setPanelHeightMode(getPanelHeightMode() === target ? "normal" : target);
}

export default function panelHeight(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.onTerminalInput((data) => {
			if (isKeyRelease(data)) return undefined;
			if (matchesKey(data, Key.ctrlAlt("f"))) {
				toggle("fullscreen");
				return { consume: true };
			}
			if (matchesKey(data, Key.ctrlAlt("m"))) {
				toggle("minimized");
				return { consume: true };
			}
			return undefined;
		});
	});
}
