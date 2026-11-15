/**
 * Which tree a `work` call means: one the broker holds, named by its key
 * or path, or one something else holds, such as a quest, found by a path
 * inside it.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HeldTree } from "../../../lib/core/work/broker.ts";
import {
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "../../../lib/core/work/events.ts";

/** Find a held tree by the key or path a caller named. */
export function heldByName(held: readonly HeldTree[], name: string) {
	return held.find((h) => h.identity.key === name || h.path === name);
}

/** Who a tree another holder claims was cut by, as far as this tool knows. */
export const CLAIMED_PROVIDER = "claimed";

/**
 * A tree something else holds, such as a quest, found by a path inside
 * it. This tool did not cut it and keeps no record of it, but its
 * reads, commits and pushes work in it the same, so a tree a quest cut
 * does not have to be driven with raw git. It is never released from
 * here: the holder owns that.
 *
 * Its path is the checkout git runs in, which need not be the claim
 * itself: `quest tree-add` cuts a World tree as a folder holding its
 * checkout in `src/`, and git run in the folder answered "not a git
 * repository" to every branch and commit (seen 2026-10-14 and again on
 * 2026-10-25).
 */
export function claimedTree(
	pi: ExtensionAPI,
	name: string,
): HeldTree | undefined {
	const expanded =
		name === "~" || name.startsWith("~/")
			? join(homedir(), name.slice(1))
			: name;
	if (!isAbsolute(expanded)) return undefined;
	const claims: TreeClaims = { paths: [], untilSpent: [] };
	pi.events.emit(WORK_TREE_CLAIMS, claims);
	const asked = resolved(expanded);
	const holder = [...claims.paths, ...(claims.untilSpent ?? [])]
		.map(resolved)
		.filter((p) => asked === p || asked.startsWith(`${p}${sep}`))
		.sort((a, b) => b.length - a.length)[0];
	if (holder === undefined || !existsSync(holder)) return undefined;
	return {
		identity: { key: holder, shareable: false },
		path: checkoutWithin(asked, holder) ?? holder,
		providerId: CLAIMED_PROVIDER,
	};
}

/**
 * The checkout a path inside a claim belongs to, kept inside the claim:
 * the nearest folder from the path up to the claim holding a `.git`,
 * else the claim's one child folder holding one. Nothing when neither
 * settles it, so a claim with several checkouts below it is never
 * guessed at.
 */
function checkoutWithin(asked: string, holder: string): string | undefined {
	for (let dir = asked; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dir === holder || !dir.startsWith(`${holder}${sep}`)) break;
	}
	let children: string[];
	try {
		children = readdirSync(holder, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(holder, entry.name))
			.filter((child) => existsSync(join(child, ".git")));
	} catch {
		// A claim that can't be listed has no checkout we can name.
		return undefined;
	}
	return children.length === 1 ? children[0] : undefined;
}

/**
 * One path, resolved the way git reports one.
 *
 * Git names a worktree with every symlink resolved and the broker
 * wrote down whatever it was handed, so on macOS the same tree is
 * `/private/var/...` from one and `/var/...` from the other. Compared
 * raw, a tree somebody is holding right now reads as abandoned, and
 * that is the one wrong answer here that costs work.
 */
export function resolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// Gone from disk, which is not this verb's problem: the broker's
		// memory already drops what it cannot find, and a path git just
		// named cannot be missing. Either way the unresolved path is
		// still the best name for it.
		return path;
	}
}
