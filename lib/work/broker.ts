/**
 * Handing out trees and taking them back.
 *
 * The broker is the piece that made three tree contracts look like
 * three problems. Each one held its own trees, keyed them its own
 * way, and reimplemented the same two questions: does one of these
 * already answer the request, and who serves this repo. Both
 * questions now have one answer each, in `tree.ts` and
 * `provider.ts`, so what is left here is genuinely just custody.
 */

import type { Owner } from "../process/index.js";
import type { TreeMemory } from "./memory.js";
import { chooseTreeProvider, type TreeProviderInfo } from "./provider.js";
import {
	satisfies,
	type TreeIdentity,
	type TreeRequest,
	treeIdentity,
} from "./tree.js";

/** A tree the broker is holding on somebody's behalf. */
export interface HeldTree {
	/** What this tree is, which is what makes it reusable. */
	identity: TreeIdentity;
	/** Absolute path to the working directory. */
	path: string;
	/**
	 * Who cut it. Recorded because the chosen provider can change
	 * between cutting and releasing, since registration is
	 * dynamic, and a tree has to go back to whoever made it.
	 */
	providerId: string;
	/**
	 * The sessions holding it, which is a list because a snapshot is
	 * shareable and two of them can want the same commit at once.
	 *
	 * One field would mean the second session to take a shared tree
	 * erased the first, and the first is still working in it: a single
	 * owner is only correct for a tree nobody may share, and the
	 * shareable kind is the kind this leaks most of.
	 *
	 * Optional because a record written before this existed has none,
	 * and because a machine that will not report a start time gives
	 * half an identity, which is worse than none: a pid alone reads as
	 * whoever holds that number next. Absent means "nobody can say",
	 * which every reader here treats as still held.
	 */
	owners?: Owner[];
}

/** Something that can cut a tree and take it back. */
export interface TreeProvider extends TreeProviderInfo {
	/**
	 * Cut a tree for this request. The broker has already decided
	 * that no held tree answers it, so a provider does not need to
	 * dedupe.
	 */
	ensure(request: TreeRequest): Promise<{ path: string }>;
	/**
	 * Give up whatever backs this tree. Providers decide whether
	 * that means deleting it, leaving it, or nothing at all.
	 */
	release(held: HeldTree): Promise<void>;
}

/**
 * What became of a release.
 *
 * A discriminated answer rather than nothing, because the interesting case is
 * the one that used to be silent: no provider registered under the id the tree
 * was cut by, so there is nothing to remove it through. That used to drop the
 * record and return, and the tool said "Released" about a directory still on
 * disk and still tracked by git, now with no record pointing at it. Reporting
 * success for doing nothing is the one outcome nobody can detect.
 */
export type ReleaseOutcome =
	| {
			kind: "released";
			/**
			 * How many other sessions are still standing in it, when the
			 * directory was therefore left where it is.
			 *
			 * Absent means it was taken down. A caller that tells somebody
			 * the tree is gone would otherwise be wrong for a shared
			 * snapshot, which is the kind two sessions hold at once.
			 */
			kept?: number;
	  }
	/** Nothing here can remove it, so it is still there and still recorded. */
	| {
			kind: "no-provider";
			/** Who cut it, which is who is missing. */
			wanted: string;
			/** Who is registered, so a mismatch reads as a correction. */
			registered: readonly string[];
			path: string;
	  };

/** Custody of the trees a session is using. */
export interface TreeBroker {
	/** Get a tree for this request, reusing one where possible. */
	ensure(request: TreeRequest): Promise<HeldTree>;
	/** Hand a tree back to the provider that cut it, and say what happened. */
	release(held: HeldTree): Promise<ReleaseOutcome>;
	/**
	 * Every tree held, this session's first and then any left behind by an
	 * earlier one.
	 *
	 * A tree outlives the process that cut it, so "held" cannot mean "cut by
	 * me". It used to, and the result was every verb refusing on a tree that
	 * plainly existed, with commits inside it and no way back to them.
	 */
	held(): readonly HeldTree[];
	/**
	 * Those a running session would miss, which is a narrower set.
	 *
	 * `held` answers what is reachable, and that has to include a dead
	 * session's trees: finding them is the whole reason the record
	 * exists. This answers what is claimed, which is the only question
	 * worth asking before taking a directory away, and the two were
	 * the same set for as long as nothing recorded who cut anything.
	 * Every tree ever cut therefore read as claimed, so nothing was
	 * ever reclaimable: 59 records and 649MB on the machine where
	 * this was found.
	 */
	stillHeld(): Promise<readonly HeldTree[]>;
	/** Those held only because nothing recorded who cut them. */
	unattributed(): readonly HeldTree[];
	/** Whether this session is the one that cut a tree, for a listing to say so. */
	cutHere(path: string): boolean;
}

/** What a broker needs beyond its providers. */
export interface BrokerDeps {
	providers: readonly TreeProvider[] | (() => readonly TreeProvider[]);
	/**
	 * Where to write down what was cut, so the next session can find it.
	 *
	 * Optional because a caller with no interest in outliving itself, which
	 * means every test, should not have to supply a directory to get a broker.
	 */
	memory?: TreeMemory;
}

/**
 * Hold the trees a session is using.
 *
 * Refuses rather than guessing when the provider choice is not
 * clear. Cutting a tree from a provider nobody chose is the failure
 * this is built to avoid: it succeeds, so nothing draws attention
 * to it, and the tree is merely wrong rather than missing.
 *
 * The roster may be a function rather than an array, and usually
 * should be. Providers arrive over the bus from other packages, and
 * load order between extensions is not something either one
 * chooses, so a broker that snapshotted its roster at construction
 * would be permanently blind to whichever provider happened to load
 * second. An array stays accepted for a caller that genuinely has a
 * fixed set, such as a test.
 */
export function createTreeBroker(
	said: readonly TreeProvider[] | (() => readonly TreeProvider[]) | BrokerDeps,
): TreeBroker {
	const deps: BrokerDeps =
		Array.isArray(said) || typeof said === "function"
			? { providers: said as BrokerDeps["providers"] }
			: (said as BrokerDeps);
	const { providers, memory } = deps;
	const trees: HeldTree[] = [];
	const roster = (): readonly TreeProvider[] =>
		typeof providers === "function" ? providers() : providers;

	/**
	 * This session's trees, then remembered ones it does not already hold.
	 *
	 * Ordered that way deliberately: a tree cut here is the one the caller just
	 * asked about, and deduping by path keeps a remembered copy of it from
	 * appearing twice under two names for the same directory.
	 */
	const everything = (): readonly HeldTree[] => {
		const mine = new Set(trees.map((tree) => tree.path));
		const earlier = (memory?.recall() ?? []).filter(
			(tree) => !mine.has(tree.path),
		);
		return [...trees, ...earlier];
	};

	return {
		unattributed() {
			// Never this session's. Ours were stamped as they were cut, so
			// anything unattributable came from a record on disk.
			const mine = new Set(trees.map((tree) => tree.path));
			return (memory?.unattributed() ?? []).filter(
				(tree) => !mine.has(tree.path),
			);
		},

		async stillHeld() {
			const mine = new Set(trees.map((tree) => tree.path));
			// Ours are held by definition, whatever a record says: this
			// process is running, since it is the one asking.
			const earlier = (await memory?.heldNow())?.filter(
				(tree) => !mine.has(tree.path),
			);
			return [...trees, ...(earlier ?? [])];
		},

		async ensure(request) {
			// Searches remembered trees too, so a second session reuses what the
			// first cut instead of asking a provider to cut a tree that is
			// already there. The git provider survives that (it treats "already
			// there" as the ordinary case) but only because it was taught to;
			// asking is still wrong when we know the answer.
			const reusable = everything().find((tree) =>
				satisfies(tree.identity, request),
			);
			if (reusable) {
				// Taking a tree is holding it, however it was obtained. A
				// reused tree still carries whoever cut it, and that session
				// is usually gone: without this, the tree this session is
				// working in reads as nobody's, and reclaiming it is exactly
				// the thing that must never happen. Held locally as well,
				// since our own list is what makes this session's answer true
				// whatever the record on disk says.
				if (!trees.some((tree) => tree.path === reusable.path)) {
					trees.push(reusable);
				}
				await memory?.rememberHeldByUs(reusable);
				return reusable;
			}

			const choice = chooseTreeProvider(roster(), request.repo);
			if (choice.kind === "none") {
				throw new Error(
					`No provider serves ${request.repo.key}, so there is nowhere to cut a tree from.`,
				);
			}
			if (choice.kind === "ambiguous") {
				const names = choice.providers.map((p) => p.id).join(" and ");
				throw new Error(
					`Both ${names} are configured to serve ${request.repo.key}, so which cuts the tree would be arbitrary. Leave one of them out.`,
				);
			}

			const { path } = await choice.provider.ensure(request);
			const held: HeldTree = {
				identity: treeIdentity(request),
				path,
				providerId: choice.provider.id,
			};
			trees.push(held);
			// Awaited, though it costs a `ps` on the way out of every cut.
			// Left running in the background it is a write that may not
			// have happened when the caller gets the tree, and a one-shot
			// session can be gone by then: the record exists precisely so
			// the next session finds the tree, so losing the race loses
			// the tree, which is the fault this whole module was written
			// for. A few milliseconds against cutting a worktree is not a
			// cost worth that.
			await memory?.rememberHeldByUs(held);
			return held;
		},

		async release(held) {
			const all = roster();
			const owner = all.find((provider) => provider.id === held.providerId);

			// Nothing to release through, so nothing is released. The record
			// stays, because it is the only pointer at a directory that is still
			// there: dropping it is how a tree becomes garbage nothing can name.
			// A tree that keeps appearing in a listing is recoverable once the
			// provider loads; one nobody has a record of is not.
			if (!owner) {
				return {
					kind: "no-provider",
					wanted: held.providerId,
					registered: all.map((provider) => provider.id),
					path: held.path,
				};
			}

			const at = trees.findIndex((tree) => tree.path === held.path);
			if (at >= 0) trees.splice(at, 1);

			// Giving up our share of a shared tree is not taking it away.
			// A snapshot can be held by two sessions, and once this change
			// started writing that down, releasing had to read it: taking
			// the directory while somebody else is standing in it is the
			// failure this whole change is about, arriving through the one
			// door that always could remove a tree.
			const others = await memory?.otherHolders(held.path);
			if (others !== undefined && others.length > 0) {
				await memory?.forgetUsAsHolder(held.path);
				return { kind: "released", kept: others.length };
			}

			// Forgotten before the provider acts, so a provider that throws
			// halfway does not leave a record claiming a tree that is now
			// half-gone. A record for a tree still on disk is recoverable on the
			// next cut; a record for a broken one is a trap.
			memory?.forget(held.path);
			await owner.release(held);
			return { kind: "released" };
		},

		held: () => everything(),

		cutHere: (path) => trees.some((tree) => tree.path === path),
	};
}
