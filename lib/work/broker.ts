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

/** Custody of the trees a session is using. */
export interface TreeBroker {
	/** Get a tree for this request, reusing one where possible. */
	ensure(request: TreeRequest): Promise<HeldTree>;
	/** Hand a tree back to the provider that cut it. */
	release(held: HeldTree): Promise<void>;
	/**
	 * Every tree held, this session's first and then any left behind by an
	 * earlier one.
	 *
	 * A tree outlives the process that cut it, so "held" cannot mean "cut by
	 * me". It used to, and the result was every verb refusing on a tree that
	 * plainly existed, with commits inside it and no way back to them.
	 */
	held(): readonly HeldTree[];
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
		async ensure(request) {
			// Searches remembered trees too, so a second session reuses what the
			// first cut instead of asking a provider to cut a tree that is
			// already there. The git provider survives that (it treats "already
			// there" as the ordinary case) but only because it was taught to;
			// asking is still wrong when we know the answer.
			const reusable = everything().find((tree) =>
				satisfies(tree.identity, request),
			);
			if (reusable) return reusable;

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
			memory?.remember(held);
			return held;
		},

		async release(held) {
			const owner = roster().find(
				(provider) => provider.id === held.providerId,
			);
			const at = trees.findIndex((tree) => tree.path === held.path);
			if (at >= 0) trees.splice(at, 1);
			// Forgotten before the provider acts, so a provider that throws
			// halfway does not leave a record claiming a tree that is now
			// half-gone. A record for a tree still on disk is recoverable on the
			// next cut; a record for a broken one is a trap.
			memory?.forget(held.path);
			// A provider that has since unregistered leaves nothing
			// to release through. Dropping our record of the tree is
			// the whole of what we can still do.
			if (owner) await owner.release(held);
		},

		held: () => everything(),

		cutHere: (path) => trees.some((tree) => tree.path === path),
	};
}
