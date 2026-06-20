/**
 * Guardian domain types: the contract that all command guardians
 * implement.
 *
 * A CommandGuardian detects, parses and reviews bash commands.
 * The review function returns a GuardianResult that describes
 * what should happen: allow as-is, block, or allow with a
 * rewritten command.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Result of a guardian review:
 * - ALLOW (undefined): allow the command as-is
 * - { block, reason }: block execution with a reason
 * - { rewrite }: allow execution with a rewritten command
 *
 * No guardian currently emits a rewrite: the guardians review and
 * block or allow, while the sanctioned rewrite paths are the
 * attribution splice and the interceptors. The rewrite variant is
 * retained as intentional contract surface so a future guardian can
 * opt in through the one sanctioned mutation site (register.ts)
 * rather than touching event.input.command directly.
 */
export type GuardianResult =
	| undefined
	| { block: true; reason: string }
	| { rewrite: string };

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
	/** Review the parsed command. Shows UI, returns the decision. */
	review(parsed: T, ctx: ExtensionContext): Promise<GuardianResult>;
}
