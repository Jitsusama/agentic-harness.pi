/**
 * Where Google Workspace credentials live on disk.
 *
 * Adapter-neutral on purpose, the same reasoning as slack's own
 * paths module (and memory's, and web's before it): this is shared
 * library code any adapter can depend on, so it must not bake in
 * one adapter's brand.
 *
 * A clean break from pi's own former path
 * (`~/.pi/agent/google-workspace.json`), not a migrated one: a
 * stored OAuth token is cheap to lose and easy to replace by
 * re-running the setup flow once, unlike a browser comparison
 * baseline or a quest worktree, so there is no injectable override
 * here for an adapter to point at its old location.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Honours XDG_CONFIG_HOME; falls back to ~/.config per the XDG spec. */
function xdgConfigRoot(): string {
	const override = process.env.XDG_CONFIG_HOME;
	return override && override.length > 0
		? override
		: join(homedir(), ".config");
}

/** Where the OAuth app and account credentials are stored. */
export function credentialsPath(): string {
	return join(xdgConfigRoot(), "agentic-harness", "google", "credentials.json");
}
