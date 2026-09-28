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
import {
	DOCK_HOP_KEY,
	hopIntoDock,
	noteReplacing,
	watchKeys,
} from "../../lib/ui/dock.ts";
import { closeEveryPanel } from "../../lib/ui/panel-registry.ts";

export default function panelLifecycle(pi: ExtensionAPI): void {
	let unwatch: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		noteReplacing(false);
		unwatch?.();
		unwatch = watchKeys(ctx);
	});
	pi.on("session_shutdown", () => {
		unwatch?.();
		unwatch = undefined;
		closeEveryPanel();
	});
	// A replace is announced before its teardown stops the turn, and a gate
	// that stop closes would leave a record in a transcript about to be
	// rebuilt without it. Another handler may cancel the replace, so the
	// next thing the person or the agent does says it is not coming.
	pi.on("session_before_switch", () => noteReplacing(true));
	pi.on("session_before_fork", () => noteReplacing(true));
	pi.on("agent_start", () => noteReplacing(false));
	pi.on("input", () => {
		noteReplacing(false);
		return { action: "continue" };
	});
	pi.registerShortcut(DOCK_HOP_KEY, {
		description: "Move between the editor and the board above it",
		handler: () => hopIntoDock(),
	});
}
