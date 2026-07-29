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
	/** Every tree currently held, in the order it was cut. */
	held(): readonly HeldTree[];
}

/**
 * Hold the trees a session is using.
 *
 * Refuses rather than guessing when the provider choice is not
 * clear. Cutting a tree from a provider nobody chose is the failure
 * this is built to avoid: it succeeds, so nothing draws attention
 * to it, and the tree is merely wrong rather than missing.
 */
export function createTreeBroker(
	providers: readonly TreeProvider[],
): TreeBroker {
	const trees: HeldTree[] = [];

	return {
		async ensure(request) {
			const reusable = trees.find((tree) => satisfies(tree.identity, request));
			if (reusable) return reusable;

			const choice = chooseTreeProvider(providers, request.repo);
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
			return held;
		},

		async release(held) {
			const owner = providers.find(
				(provider) => provider.id === held.providerId,
			);
			const at = trees.findIndex((tree) => tree.path === held.path);
			if (at >= 0) trees.splice(at, 1);
			// A provider that has since unregistered leaves nothing
			// to release through. Dropping our record of the tree is
			// the whole of what we can still do.
			if (owner) await owner.release(held);
		},

		held: () => [...trees],
	};
}
