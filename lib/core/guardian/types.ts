/**
 * The shared shape a guardian's content gates hand back to their
 * adapter: allow, block, or (reserved, unused today) rewrite.
 *
 * The full `CommandGuardian<T>` contract -- detect/parse/review
 * over a live host context -- stays adapter-local, since `review`
 * needs a host's own confirmation UI. This is only the result
 * shape the pure gates (prose, section, title) return, shared so
 * every adapter's glue speaks the same result.
 */

/**
 * Result of a guardian review:
 * - ALLOW (undefined): allow the command as-is
 * - { block, reason }: block execution with a reason
 * - { rewrite }: allow execution with a rewritten command
 *
 * No guardian emits a rewrite today: the content gates block or
 * allow, while a sanctioned rewrite (an attribution splice, an
 * interceptor's corrected command) is each adapter's own doing.
 * The rewrite variant is retained as intentional contract surface
 * for a future gate that wants it.
 */
export type GuardianResult = undefined | GuardianBlock | { rewrite: string };

/**
 * A refusal, named so a function that can only refuse can say so.
 *
 * Returning the whole union from something that never rewrites lets
 * the rewrite variant leak into a caller that only accepts a block.
 */
export type GuardianBlock = { block: true; reason: string };

/** Allow the command as-is. Named constant for self-documenting returns. */
export const ALLOW: GuardianResult = undefined;
