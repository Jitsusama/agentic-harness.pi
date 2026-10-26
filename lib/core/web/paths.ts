/**
 * Where durable browser artifacts (baselines) live on disk by
 * default, when an adapter does not say otherwise.
 *
 * Deliberately adapter-neutral, the same reasoning as memory's own
 * path: a baseline taken while driving the browser through pi is
 * still worth comparing against when the same page is later driven
 * through Claude Code, so the default does not scope itself under
 * either adapter's own brand. An adapter with its own established
 * convention (pi's `dataDir("browser-integration")`, predating this
 * library) passes `dataRoot` on `SessionOptions` instead, so moving
 * this library out from under it does not orphan baselines already
 * on disk.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Honours XDG_DATA_HOME; falls back to ~/.local/share per the XDG spec. */
function xdgDataRoot(): string {
	const override = process.env.XDG_DATA_HOME;
	return override && override.length > 0
		? override
		: join(homedir(), ".local", "share");
}

/** The default root for durable browser artifacts. */
export function defaultBrowserDataRoot(): string {
	return join(xdgDataRoot(), "agentic-harness", "browser");
}
