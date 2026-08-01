/**
 * Answering the working layer when it asks who holds a tree.
 *
 * A quest cuts worktrees and records them on its frontmatter, which
 * the working layer's broker knows nothing about. From git's side the
 * two are identical: a directory, a branch, and no record in the
 * broker's memory. So the working layer's reclamation would happily
 * take back a tree a live quest is holding, and the first run of it
 * against a real repository did exactly that.
 *
 * The fix belongs here rather than there. The working layer must not
 * learn what a quest is, and asking over the bus means any other
 * package that cuts trees can answer the same question without either
 * side importing the other.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverQuests } from "../../lib/internal/quest/discovery.js";
import { type TreeClaims, WORK_TREE_CLAIMS } from "../../lib/work/index.js";

/**
 * Answer the working layer's question about held trees.
 *
 * Every quest is asked, whatever its status. A concluded quest that
 * still lists a tree is still the reason that tree is on disk, and
 * treating conclusion as a release would hand back exactly the trees
 * whose owner has stopped watching them. Releasing is `tree-prune`,
 * which is a decision somebody makes on purpose.
 */
export function answerTreeClaims(pi: ExtensionAPI, questsRoot: string): void {
	pi.events.on(WORK_TREE_CLAIMS, (data: unknown) => {
		const claims = data as TreeClaims;
		const { index } = discoverQuests(questsRoot);
		for (const entry of index.quests.values()) {
			for (const tree of entry.doc.frontMatter.trees ?? []) {
				claims.paths.push(tree.path);
			}
		}
	});
}
