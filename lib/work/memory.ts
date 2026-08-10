/**
 * Remembering the trees a session cut, so the next session can find them.
 *
 * The broker held its trees in an array, which is correct for exactly as long as
 * the process lives. A worktree outlives the process by design, so the next
 * session opened with the trees still on disk, git still tracking them, and
 * every verb answering "no held tree": not merely a listing that forgot, but
 * commits stranded in a directory the tool could no longer reach, releasable
 * only through the `git worktree` call the guide tells you never to make.
 *
 * No test could see it. A test builds a broker and uses it, which is one
 * process; the fault needs two.
 *
 * The directory stays the source of truth for whether a tree exists, and this
 * only supplies the identity a directory name cannot faithfully carry. When the
 * two disagree the directory wins, because somebody who deletes a tree by hand
 * has said something and a stale record has not.
 *
 * A record also says who cut it, which is a later addition and the reason
 * anything is ever reclaimed. Without it "remembered" and "held" were one set,
 * so every tree ever cut answered "something still holds it" forever: measured
 * at 59 records and 649MB on one machine, growing by a snapshot per review
 * round.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	askedOnce,
	isOwner,
	type Owner,
	ownerNow,
	ownerStanding,
	type ProcessFacts,
	sameProcess,
	systemFacts,
} from "../process/index.js";
import type { HeldTree } from "./broker.js";

/** Somewhere to write down what was cut. */
export interface TreeMemory {
	/** Write a tree down, so a later session can find it. */
	remember(held: HeldTree): void;
	/**
	 * Write a tree down as held by this session.
	 *
	 * Separate from `remember`, which stays exactly as literal as it was: a
	 * caller replaying a record, or a test constructing one, must be able to
	 * write what it means rather than have this process's identity stamped
	 * over it.
	 */
	rememberHeldByUs(held: HeldTree, facts?: ProcessFacts): Promise<void>;
	/** Forget one, once it has genuinely gone. */
	forget(path: string): void;
	/** Every tree written down that is still on disk. */
	recall(): readonly HeldTree[];
	/**
	 * Those a running session still holds.
	 *
	 * Distinct from `recall`, which must keep returning a dead session's
	 * trees: reusing the snapshot a finished round left behind is the point
	 * of a shareable tree, and it is what lets six reviewers of one commit
	 * share one directory. This is the narrower question tidy asks, and only
	 * tidy: whether taking the directory away would pull it out from under
	 * somebody.
	 */
	heldNow(facts?: ProcessFacts): Promise<readonly HeldTree[]>;
	/**
	 * Those whose record does not say who cut them.
	 *
	 * A subset of what `heldNow` returns, since an unattributable tree is
	 * counted as held: this names them so a caller can report them as the
	 * decision they are rather than as a claim somebody made.
	 */
	unattributed(): readonly HeldTree[];
	/**
	 * Who else is standing in this tree, this session excluded.
	 *
	 * Only holders still running count, since a dead one is not
	 * somebody a release has to be careful of. Empty for a tree nobody
	 * else holds and for one whose record names nobody, which is right
	 * for a release: the caller asked to take its own tree down, and
	 * only another live session is a reason not to.
	 */
	otherHolders(path: string, facts?: ProcessFacts): Promise<readonly Owner[]>;
	/** Take this session off a tree's record, leaving the record. */
	forgetUsAsHolder(path: string, facts?: ProcessFacts): Promise<void>;
}

/** A record as it sits on disk. */
interface Written {
	identity?: HeldTree["identity"];
	path?: string;
	providerId?: string;
}

/**
 * The holders a record names, ignoring anything malformed.
 *
 * Checks that it is an array before filtering it. A record is a file
 * anybody can edit, and `owners: {}` on one of them would otherwise
 * throw out of here and take tidy and reclaim down with it: one bad
 * file, and the whole cleanup path stops for every repo.
 */
function named(tree: HeldTree): readonly Owner[] {
	const owners: unknown = tree.owners;
	if (!Array.isArray(owners)) return [];
	return owners.filter(isOwner);
}

/** Whether two records name one process. */
function sameOwner(one: Owner, two: Owner): boolean {
	return one.pid === two.pid && sameProcess(one.startedAt, two.startedAt);
}

/** Whether a record read back off disk says enough to be useful. */
function usable(written: Written): written is Required<Written> {
	return (
		typeof written.path === "string" &&
		typeof written.providerId === "string" &&
		typeof written.identity?.key === "string"
	);
}

/**
 * Remember trees in a directory of small files, one per tree.
 *
 * A file per tree rather than one index, for the same reason the attachment
 * store is shaped this way: two sessions cutting trees at once both write, and
 * the loser of a read-modify-write race on a single index is a tree nobody can
 * find. Separate files cannot collide, since the name is the tree's own key.
 */
export function createTreeMemory(dir: string): TreeMemory {
	const fileFor = (key: string): string =>
		join(dir, `${key.replaceAll("/", "-")}.json`);

	function all(): readonly { at: string; held: HeldTree }[] {
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.flatMap((name) => {
				const at = join(dir, name);
				try {
					const written: Written = JSON.parse(readFileSync(at, "utf8"));
					// A record we cannot read is worse than no record, because it
					// would mean a tree reported with a broken identity. Skip it
					// and leave it alone: deleting somebody's file to tidy a
					// listing is not this function's decision.
					return usable(written)
						? [{ at, held: written as unknown as HeldTree }]
						: [];
				} catch {
					// Unreadable or half-written, which a concurrent write can
					// produce. The tree is still on disk and still reachable by
					// path; only its identity is lost, and next cut rewrites it.
					return [];
				}
			});
	}

	return {
		remember(held) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				fileFor(held.identity.key),
				JSON.stringify(held, null, 2),
				"utf8",
			);
		},

		async rememberHeldByUs(held, facts = systemFacts) {
			// Stamped here rather than by the caller, so a tree cannot be
			// written down without the identity that lets it be released
			// later. The owner is this process: whoever asks the broker for a
			// tree is the session that will be holding it.
			const us = await ownerNow(facts);
			if (us === undefined) {
				// The machine will not say when we started, so we cannot write
				// an identity anybody could check later. Recording the tree
				// without one is right: it reads as unattributable, which is
				// held, and a tree wrongly held costs disk where a tree
				// wrongly reclaimed costs work.
				this.remember(held);
				return;
			}
			// Added to whoever else holds it rather than replacing them. A
			// snapshot is shareable, so two sessions can hold one tree, and
			// the one that wrote last is not the only one that would miss it.
			// Dead holders are left to be filtered on the way out rather than
			// probed here, since this is on the path of every cut.
			const before = (
				this.recall().find((tree) => tree.path === held.path)?.owners ??
				held.owners ??
				[]
			).filter((one) => isOwner(one) && !sameOwner(one, us));
			this.remember({ ...held, owners: [...before, us] });
		},

		forget(path) {
			for (const { at, held } of all()) {
				if (held.path === path) rmSync(at, { force: true });
			}
		},

		recall() {
			const found: HeldTree[] = [];
			for (const { at, held } of all()) {
				// The directory is the truth. A record whose tree has been
				// removed by hand is dropped and its record with it, which is
				// how somebody who cleaned up by hand stops being nagged about
				// it forever.
				if (existsSync(held.path)) {
					found.push(held);
					continue;
				}
				rmSync(at, { force: true });
			}
			return found;
		},

		unattributed() {
			return this.recall().filter((tree) => named(tree).length === 0);
		},

		async otherHolders(path, facts = systemFacts) {
			const tree = this.recall().find((one) => one.path === path);
			if (tree === undefined) return [];
			const once = askedOnce(facts);
			const us = await ownerNow(once);
			const others: Owner[] = [];
			for (const owner of named(tree)) {
				if (us !== undefined && sameOwner(owner, us)) continue;
				if ((await ownerStanding(owner, once)) !== "gone") others.push(owner);
			}
			return others;
		},

		async forgetUsAsHolder(path, facts = systemFacts) {
			const tree = this.recall().find((one) => one.path === path);
			if (tree === undefined) return;
			const us = await ownerNow(facts);
			if (us === undefined) return;
			this.remember({
				...tree,
				owners: named(tree).filter((owner) => !sameOwner(owner, us)),
			});
		},

		async heldNow(facts = systemFacts) {
			const held: HeldTree[] = [];
			// One question per process, not per record. Every reviewer of
			// one round shares a session, so the same handful of pids
			// recurs across the whole directory: without this, tidy forked
			// `ps` once per record, serially, which is 59 spawns on the
			// machine this was found on.
			//
			// The fact is cached, never the verdict. A standing compares
			// the pid's real start time against the one a given record
			// wrote down, so it belongs to the record and not to the pid:
			// held per pid, one stale record answers for a live session
			// wearing the same number, which is the exact confusion this
			// module exists to prevent.
			const once = askedOnce(facts);

			for (const tree of this.recall()) {
				const owners = named(tree);
				// Nobody recorded means nobody can say, and every record
				// written before owners existed is one of these. Reading it as
				// nobody's would offer a live session's trees for reclaiming on
				// the first run of this code, which is worse than the leak it
				// fixes.
				if (owners.length === 0) {
					held.push(tree);
					continue;
				}
				// Any one of them is enough. A shared snapshot outlives the
				// first holder to finish with it.
				const stands = await Promise.all(
					owners.map((owner) => ownerStanding(owner, once)),
				);
				if (stands.some((one) => one !== "gone")) held.push(tree);
			}
			return held;
		},
	};
}
