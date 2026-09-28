/**
 * Panel Lifecycle extension.
 *
 * Closes every panel when its session ends, the ones on screen and the
 * ones still waiting for it, each answering the way Escape would.
 *
 * Pi's own reset at the end of a session hides the topmost overlay and
 * nothing else: the panel's promise never settles, so whoever awaited it
 * waits for good, and the shared gate queue, which outlives a reload,
 * stays held, so every later panel in every later session waits too.
 * Pi emits `session_shutdown` on every path a session ends by, and this
 * is the one handler that tells the panel registry. One is enough for
 * every copy of `lib/ui` in the process, since the registry is shared.
 *
 * It also binds the hop chord, which moves focus from the editor into the
 * topmost widget docked above it (a fleet's board, a round's). Pi consults
 * its shortcut table only while its own editor has focus, so this is the
 * editor's half of the chord; a focused widget answers the other half
 * itself. One binding reaches every copy's widgets, since the dock is
 * shared the same way the registry is.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DOCK_HOP_KEY, hopIntoDock } from "../../lib/ui/dock.ts";
import { closeEveryPanel } from "../../lib/ui/panel-registry.ts";

export default function panelLifecycle(pi: ExtensionAPI): void {
	pi.on("session_shutdown", () => {
		closeEveryPanel();
	});
	pi.registerShortcut(DOCK_HOP_KEY, {
		description: "Move between the editor and the board above it",
		handler: () => hopIntoDock(),
	});
}
