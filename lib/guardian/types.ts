/**
 * Guardian domain types: the contract that all command guardians
 * implement.
 *
 * A CommandGuardian detects, parses and reviews bash commands.
 * The review function returns a GuardianResult that describes
 * what should happen: allow as-is, block, or allow with a
 * rewritten command.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuardMode } from "./policy.ts";

/**
 * Result of a guardian review:
 * - ALLOW (undefined): allow the command as-is
 * - { block, reason }: block execution with a reason
 * - { rewrite }: allow execution with a rewritten command
 *
 * A rewrite is applied by register.ts, the one sanctioned mutation
 * site for guardians; the history guardian uses it to lease a bare
 * force push. A guardian never touches event.input.command directly.
 */
export type GuardianResult = undefined | GuardianBlock | { rewrite: string };

/**
 * A refusal, named so a function that can only refuse can say so.
 *
 * Returning the whole union from something that never rewrites made
 * the rewrite variant leak into pi's tool-call result, which accepts
 * a block and nothing else.
 */
export type GuardianBlock = { block: true; reason: string };

/** Allow the command as-is. Named constant for self-documenting returns. */
export const ALLOW: GuardianResult = undefined;

/**
 * A command guardian that intercepts and reviews bash commands.
 *
 * Generic over T, the parsed representation of the command
 * (e.g., PrCommand, IssueCommand, commit message + flags).
 */
export interface CommandGuardian<T> {
	/** Return true if this guardian should handle the command. */
	detect(command: string): boolean;
	/** Parse the command into a structured form. Return null to skip. */
	parse(command: string): T | null;
	/**
	 * Review the parsed command and return the decision.
	 *
	 * The mode is the guard's own. In `block` an approval shows its
	 * panel; in any other it reports what the panel would have shown and
	 * allows. An off guard is still reviewed, because off means the
	 * person is shown what the guard saw rather than nothing at all; a
	 * refusal a review makes goes through `refusalUnder`, which lets it
	 * through under off. A guardian written before the policy ignores
	 * the argument and keeps its old behaviour, which is what `block`
	 * means.
	 */
	review(
		parsed: T,
		ctx: ExtensionContext,
		mode?: GuardMode,
	): Promise<GuardianResult>;
}
