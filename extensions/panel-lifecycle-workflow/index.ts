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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeEveryPanel } from "../../lib/ui/panel-registry.ts";

export default function panelLifecycle(pi: ExtensionAPI): void {
	pi.on("session_shutdown", () => {
		closeEveryPanel();
	});
}
