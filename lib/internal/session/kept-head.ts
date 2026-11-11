/**
 * The head a session keeps (`first-head.ts`), told from what its branch
 * gained since it was last told rather than from the whole branch.
 *
 * It's asked before every request. Told from the whole branch, each ask
 * walked every entry and measured the patch to every compaction's head,
 * which on 10 November put 748 ms of main-thread runs of 50 ms or more
 * into ten minutes of a session with a 24 MB log, while pi read no key.
 * The kept head is a fold over the branch from its root, so it's folded
 * as the branch grows (`branch-walk.ts`).
 */

import type { SystemMessage } from "@earendil-works/pi-ai";
import {
	type BranchReader,
	foldedBranch,
	type LinkedEntry,
} from "./branch-walk.ts";
import { type HeadEntry, keptHeadAfter } from "./first-head.ts";

/** A session entry, as far as the kept head reads one. */
type BranchEntry = HeadEntry & LinkedEntry;

const keptHead = foldedBranch<SystemMessage | undefined, BranchEntry>({
	start: () => undefined,
	step: keptHeadAfter,
});

/** The head the session's branch keeps at its leaf now. */
export function keptHeadAt(
	session: BranchReader<BranchEntry>,
): SystemMessage | undefined {
	return keptHead(session);
}
