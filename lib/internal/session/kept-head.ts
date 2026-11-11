/**
 * The head a session keeps (`first-head.ts`), told from what its branch
 * gained since it was last told rather than from the whole branch.
 *
 * It's asked before every request. Told from the whole branch, each ask
 * walked every entry and measured the patch to every compaction's head,
 * which on 10 November put 748 ms of main-thread runs of 50 ms or more
 * into ten minutes of a session with a 24 MB log, while pi read no key.
 * The kept head is a fold over the branch from its root, and every entry
 * pi appends becomes the new leaf, so walking back from the leaf to the
 * one last told and folding only what lies between gives the same
 * answer. A leaf on another branch never meets the one last told, and is
 * folded from the root.
 */

import type { SystemMessage } from "@earendil-works/pi-ai";
import { type HeadEntry, keptHeadAfter, keptHeadOf } from "./first-head.ts";

/** A session entry, as far as the walk back from the leaf reads one. */
interface BranchEntry extends HeadEntry {
	readonly parentId: string | null;
}

/** The parts of pi's session manager the kept head is told from. */
export interface BranchReader {
	getLeafId(): string | null | undefined;
	getEntry(id: string): BranchEntry | undefined;
}

interface Told {
	readonly leaf: string;
	readonly kept: SystemMessage | undefined;
}

/** What was last told per session, by the session's manager, which pi keeps. */
const told = new WeakMap<object, Told>();

/** The head the session's branch keeps at its leaf now. */
export function keptHeadAt(session: BranchReader): SystemMessage | undefined {
	const leaf = session.getLeafId();
	if (!leaf) return undefined;
	const before = told.get(session);
	if (before?.leaf === leaf) return before.kept;
	const gained: BranchEntry[] = [];
	let met = false;
	let id: string | null = leaf;
	while (id !== null) {
		if (id === before?.leaf) {
			met = true;
			break;
		}
		const entry = session.getEntry(id);
		if (entry === undefined) break;
		gained.push(entry);
		id = entry.parentId;
	}
	const path = gained.reverse();
	let kept = met ? before?.kept : keptHeadOf(path);
	if (met) for (const entry of path) kept = keptHeadAfter(kept, entry);
	told.set(session, { leaf, kept });
	return kept;
}
