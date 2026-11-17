/**
 * Why the agent fence refused a command something that isn't git's,
 * and where to go instead; git's own refusals are `fence-git-route.ts`'s.
 *
 * The build keeper's socket stays outside, so nothing inside can record
 * a pass it claims, and a build run inside, through direnv or with
 * other flags, can't keep what passed. The one call that keeps a pass
 * runs outside (`offload-exemption.ts`), so the refusal gains it
 * (ISXEG8 [2fc080c2], [f1e0fa13]).
 *
 * Everything but the session's held trees, its scratch folder and a few
 * homes of tools is read-only inside, and a write elsewhere says only
 * "Read-only file system", so it gains where a command may write
 * (ISXEG8 [6e4de1de]).
 */

import { type Block, routed } from "./fence-git-route.ts";

/** The line a pass the fence kept from being kept gains. */
export const KEEP_ROUTE =
	"pi: the agent fence keeps the build keeper outside, so nothing inside can record a pass it claims. To keep a pass for a merge, run a plain `nix-offload there --changed`, or `--run` of a store program, from a tree this session holds, alone in its bash call: that call runs outside the fence and keeps what passed.";

/** The line a write outside what the session holds gains. */
export const READ_ONLY_ROUTE =
	"pi: the agent fence keeps most of the disk read-only inside, the trees this session holds and its scratch folder aside. Work in a tree you hold (`work tree` cuts one), write scratch files under $TMPDIR, or leave the change for the person.";

/** nix-offload's words for a pass it couldn't keep. */
const UNKEPT = /couldn't keep what passed/;

/** The kernel's words for a write to a read-only mount. */
const READ_ONLY = /Read-only file system/;

/**
 * `content` with the route added after the block where nix-offload said
 * it couldn't keep what passed, `record` called once for it; or
 * undefined, when no block says so.
 */
export function routedKeep<T extends Block>(
	content: readonly T[],
	record: () => void,
): T[] | undefined {
	return routed(content, UNKEPT, KEEP_ROUTE, record);
}

/**
 * `content` with the route added after the block where a write met a
 * read-only mount, `record` called once for it; or undefined, when no
 * block says so. Git's own read-only refusals go first, to their routes.
 */
export function routedReadOnly<T extends Block>(
	content: readonly T[],
	record: () => void,
): T[] | undefined {
	return routed(content, READ_ONLY, READ_ONLY_ROUTE, record);
}
