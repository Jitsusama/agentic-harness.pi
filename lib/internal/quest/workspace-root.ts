/**
 * Where this package keeps quests' workspaces: its cache directory,
 * since a workspace holds what a quest can make again or do without,
 * and the backup, Spotlight and the record audit all leave it alone.
 *
 * It lives here rather than in the quest workflow because more than
 * the quest workflow needs it: verification leaves a workspace's
 * scratch files alone, and extensions do not import one another.
 */

import { cacheDir } from "../paths.ts";

/** Where quests' workspaces live, honouring `XDG_CACHE_HOME`. */
export function questWorkspacesRoot(): string {
	return cacheDir("quest-workspace");
}
