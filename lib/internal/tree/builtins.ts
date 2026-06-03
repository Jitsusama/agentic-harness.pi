/**
 * Built-in tree providers. The harness seeds these via
 * `registerBuiltinTreeProviders`; downstream packages
 * register their own at lower priority numbers to take
 * over for specific repo roots.
 */

import type { TreeProvider } from "../../tree/types.js";
import { createGitWorktreeProvider } from "./providers/git-worktree.js";

export const BUILTIN_TREE_PROVIDERS: TreeProvider[] = [
	createGitWorktreeProvider(),
];
