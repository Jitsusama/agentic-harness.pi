/**
 * The trees this session holds, listed, and one given back: refused while
 * it holds uncommitted work, or when a quest holds it, or when the
 * provider that cut it isn't here to remove it.
 */

import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { citeListing } from "../../../lib/core/result/listing.ts";
import { openSessionStore } from "../../../lib/core/result/location.ts";
import type { HeldTree, TreeBroker } from "../../../lib/core/work/broker.ts";
import {
	blocksRepoint,
	type WorkHistory,
} from "../../../lib/core/work/history.ts";
import {
	branchesKeptForSession,
	KEPT_BRANCHES,
	type KeptBranch,
} from "../../../lib/core/work/sweep-kept-branches.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { GLYPH, treeLine } from "../render.ts";
import { sweepLockPath } from "../sweep.ts";
import { CLAIMED_PROVIDER } from "./held.ts";
import { type Answer, refuse, say } from "./shared.ts";

/**
 * The held trees that still stand, with the use of each this session
 * holds dated. A listing is how a reader finds a path to read by, and a
 * reader by path leaves no other sign, so a sweep would take a snapshot
 * read hours after it was cut. One a sweep took meanwhile is left out.
 * One whose dating is refused is still listed, since it is still held
 * and a listing never fails for its dating.
 *
 * Only this session's own are dated: those it cut, and those whose
 * records name it, as a session resumed after a restart holds its
 * own. The broker lists every tree recorded on the machine, and dating
 * one holds it, so dating them all made the lister an owner of every
 * tree, which no sweep could then take; and each dating reads the
 * whole record folder.
 */
export async function datedHeld(
	broker: Pick<TreeBroker, "used" | "heldHere">,
	held: readonly HeldTree[],
): Promise<HeldTree[]> {
	const ours = await broker.heldHere(held).catch(() => new Set<string>());
	const standing = await Promise.all(
		held.map(async (tree) => {
			if (!ours.has(tree.path)) return tree;
			try {
				return (await broker.used(tree)) ? tree : undefined;
			} catch {
				// Refused, as a held lock or a full disk does: still ours.
				return tree;
			}
		}),
	);
	return standing.filter((tree) => tree !== undefined);
}

/**
 * What to say of the worktrees the sweep took from this session, unused
 * a day with nothing only there: each branch at the head it kept, and
 * how to have it again. Nothing when none went.
 */
export function takenWhileIdle(went: readonly KeptBranch[]): string {
	if (went.length === 0) return "";
	const each = went
		.map((one) => `${one.branch} at ${one.commit.slice(0, 12)}`)
		.join(", ");
	return `${GLYPH.named} Taken while unused a day, nothing only there, each branch kept at its head: ${each}. Ask with action 'tree' and its branch to have one again as it was.`;
}

/** List the trees the broker holds, one line each, dating each use. */
export async function listHeld(
	broker: TreeBroker,
	ctx: ExtensionContext,
): Promise<Answer> {
	const held = await datedHeld(broker, broker.held());
	const session = ctx.sessionManager?.getSessionId?.();
	const went =
		session === undefined
			? ""
			: takenWhileIdle(
					branchesKeptForSession(
						join(dirname(sweepLockPath()), KEPT_BRANCHES),
						session,
					),
				);
	const after = went === "" ? "" : `\n${went}`;
	if (held.length === 0) {
		return say(
			`${GLYPH.named} No trees held. Ask for one with action 'tree' or 'snapshot'.${after}`,
			{ ok: true, held: 0 },
		);
	}
	return say(
		citeListing(openSessionStore(ctx), {
			view:
				held.map((one) => treeLine(one, broker.cutHere(one.path))).join("\n") +
				after,
			records: [...held],
			unit: "trees",
			narrowing: "Query the stored result for the trees you need.",
		}),
		{ ok: true, held: held.length },
	);
}

/** Give a held tree back, once nothing in it would be lost. */
export async function releaseTree(
	broker: TreeBroker,
	history: WorkHistory,
	found: HeldTree,
	signal: AbortSignal | undefined,
): Promise<Answer> {
	// A tree a quest holds goes back through the quest, which
	// keeps its record and knows what pruning it means.
	if (found.providerId === CLAIMED_PROVIDER) {
		return refuse(
			`${GLYPH.refused} ${found.path} is held by a quest, not by this tool. Give it back with quest tree-release, passing it as cwd.`,
		);
	}

	// The work inside is the caller's, and losing it is not
	// recoverable, so the same sentence that guards a repoint
	// guards this.
	const state = await history.status(found.path);
	const blocked = blocksRepoint(state);
	if (blocked) {
		return refuse(`${GLYPH.refused} ${blocked}`);
	}
	const gone = await broker.release(found, signal ? { signal } : {});
	if (gone.kind === "no-provider") {
		// Said as a refusal because nothing happened. This used to
		// report success, leaving a tree on disk, tracked by git, with
		// its record dropped and nothing able to name it again.
		const who =
			gone.registered.length === 0
				? "none are registered"
				: gone.registered.join(", ");
		return refuse(
			`${GLYPH.refused} ${found.identity.key} was cut by ${gone.wanted}, which is not registered here, so nothing can remove it. Registered: ${who}. The tree is still at ${displayPath(gone.path)} and still listed, so this can be retried once that provider loads.`,
		);
	}
	return say(`${GLYPH.named} Released ${found.identity.key}.`, {
		ok: true,
		released: found.identity.key,
	});
}
