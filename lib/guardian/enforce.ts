/**
 * Fail-closed enforcement for guardable commands.
 *
 * When a guardian detects its target but the command is in a shape
 * the model cannot fully parse (command substitution, a subshell, a
 * brace group, control flow), the gate must block rather than let
 * the command through unreviewed. Detection stays broad; this is the
 * check that turns an unparseable guardable command into a reissue.
 */

import { tokenize } from "../command/index.js";
import type { GuardianResult } from "./types.js";

/**
 * Block a command whose shape is outside the supported grammar,
 * with a reason that asks for a simpler form. Returns undefined
 * (allow) for a supported shape.
 */
export function blockIfUnsupported(command: string): GuardianResult {
	const line = tokenize(command);
	if (line.supported) return undefined;
	return {
		block: true,
		reason: `This command is in a shape the gate cannot fully review (${line.unsupportedReason}). Reissue it in a simple form, without command substitution, a subshell, a brace group or control flow, so it can be reviewed.`,
	};
}
