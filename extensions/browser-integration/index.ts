/**
 * Browser Integration extension.
 *
 * A family of tools over named, persistent browser sessions,
 * named for what the caller is doing: browser_go to be
 * somewhere, browser_see to read the page, browser_do to
 * change it. Elements are named the way they read in the
 * accessibility outline, so the same vocabulary works for
 * seeing and for acting.
 *
 * Sessions dispose on idle and at shutdown, on the hardened
 * shared browser lifecycle, so nothing leaks.
 *
 * No slash command: the agent (or a subagent) drives the tools.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerDo } from "./do.js";
import { registerGo } from "./go.js";
import { createSessionRegistry } from "./registry.js";
import { registerSee } from "./see.js";

export default function browserIntegration(pi: ExtensionAPI) {
	const registry = createSessionRegistry();

	pi.on("session_shutdown", async () => {
		await registry.disposeAll();
	});

	registerGo(pi, registry);
	registerSee(pi, registry);
	registerDo(pi, registry);
}
