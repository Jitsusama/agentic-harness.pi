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
import {
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "@jitsusama/agentic-harness.core/work";
import { discoverQuests } from "../../lib/internal/quest/discovery.ts";
import { isSealedStatus } from "../../lib/internal/quest/status.ts";

/**
 * Answer the working layer's question about held trees.
 *
 * Only a live quest claims the trees it lists. A concluded or retired
 * one hands them to the working layer's own judgement, which reclaims a
 * tree only when it is clean and trunk holds its branch, and reports
 * the rest rather than taking them. Claiming them for good, waiting on
 * a `tree-prune` nobody runs once a quest is over, kept 102 finished
 * trees on one machine's disk, none of them ever offered back.
 */
export function answerTreeClaims(pi: ExtensionAPI, questsRoot: string): void {
	pi.events.on(WORK_TREE_CLAIMS, (data: unknown) => {
		const claims = data as TreeClaims;
		const { index } = discoverQuests(questsRoot);
		for (const entry of index.quests.values()) {
			if (isSealedStatus(entry.doc.frontMatter.status)) continue;
			for (const tree of entry.doc.frontMatter.trees ?? []) {
				claims.paths.push(tree.path);
			}
		}
	});
}
