/**
 * Where Slack credentials and cached lookups live on disk.
 *
 * Adapter-neutral on purpose, the same reasoning as memory's and
 * web's own paths: this module is shared library code any adapter
 * can depend on, so it must not bake in one adapter's brand. A
 * Claude Code process storing its own Slack token at a path named
 * after pi would be as wrong as the reverse.
 *
 * This is a clean break from pi's own former path
 * (`~/.pi/agent/slack.json`, `~/.pi/agent/slack/`), not a
 * migrated one: unlike a browser comparison baseline or a quest
 * worktree, a stored OAuth token is cheap to lose and easy to
 * replace, so there is no injectable override here for an adapter
 * to point at its old location. Re-running the setup flow once is
 * the whole cost.
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

/** Honours XDG_CACHE_HOME; falls back to ~/.cache per the XDG spec. */
function xdgCacheRoot(): string {
	const override = process.env.XDG_CACHE_HOME;
	return override && override.length > 0 ? override : join(homedir(), ".cache");
}

/** Where the OAuth app and token credentials are stored. */
export function credentialsPath(): string {
	return join(xdgConfigRoot(), "agentic-harness", "slack", "credentials.json");
}

/**
 * Where resolved user and channel names are cached.
 *
 * Cache rather than config: every entry here is a name Slack's API
 * already answered once and is cheap to ask again, never something
 * a person edits or that losing would cost them anything but a
 * refetch.
 */
export function cacheDir(): string {
	return join(xdgCacheRoot(), "agentic-harness", "slack");
}
